import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真库走一遍邀请返券：设置、生成邀请码、记邀请、冷静期发券、结账用券、退款。对应设计 §12.3。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = join(tmpdir(), "kaimi-referral-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));
// 邮件和 Telegram 不真发，记下调用
const sent = vi.hoisted(() => ({
  mails: [] as Array<{ agentId: number; to: string; subject: string; text: string }>,
  telegram: [] as Array<{ chatId: string; text: string }>,
  mailMode: "sent" as "sent" | "skip" | "throw",
}));
vi.mock("@/lib/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail")>()),
  sendShopMail: vi.fn(
    async (input: {
      agentId: number;
      to: string;
      template: import("@/lib/mail-template-core").MailTemplateKey;
      context: (s: string) => Omit<import("@/lib/mail-template-core").MailContext, "afterSales">;
    }) => {
      if (sent.mailMode === "throw") throw new Error("SMTP 连不上");
      if (sent.mailMode === "skip") return { sent: false, reason: "平台订单邮件未开启" };
      // 用系统默认模板渲染，断言的就是买家实际收到的文字
      const core = await import("@/lib/mail-template-core");
      const rendered = core.renderMailTemplate(input.template, core.MAIL_TEMPLATE_DEFS[input.template].system, input.context("测试店"));
      sent.mails.push({ agentId: input.agentId, to: input.to, subject: rendered.subject, text: rendered.text });
      return { sent: true };
    },
  ),
}));
vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  dispatchNotifyText: vi.fn(async (text: string, _extra: unknown, _event: string, overrides: { telegramChatId?: string }) => {
    sent.telegram.push({ chatId: overrides.telegramChatId || "", text });
    return { telegram: { ok: true, attempted: true }, webhook: { ok: true, attempted: false } };
  }),
}));

type Modules = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  ref: typeof import("./referrals");
  orders: typeof import("./store-orders");
  config: typeof import("./config");
  orm: typeof import("drizzle-orm");
};
let m: Modules;
let seq = 0;
const mail = (local: string, domain = "qq.com") => `${local}@${domain}`;
const DAY = 86_400_000;

type Shop = { agentId: number; slug: string; plusId: number; proId: number; actor: { id: number; role: "agent" } };

async function seedShop(): Promise<Shop> {
  const { db, schema } = m;
  seq += 1;
  const slug = `refshop${seq}`;
  const [agent] = await db.insert(schema.agents).values({ displayName: `店${seq}`, currentSlug: slug }).returning();
  const plans: Record<string, number> = {};
  for (const [key, retail, cost] of [
    ["plus", 15000, 11800],
    ["pro", 115500, 98000],
  ] as const) {
    const planKey = `ref_${key}_${seq}`;
    const [plan] = await db
      .insert(schema.platformPlans)
      .values({ planKey, name: key === "plus" ? "Plus" : "Pro", globalCostPriceCents: cost, cardplatformSellable: true, enabled: true })
      .returning();
    await db.insert(schema.agentPlanPrices).values({
      agentId: agent.id,
      planId: plan.id,
      retailPriceCents: retail,
      enabled: true,
    });
    plans[key] = plan.id;
  }
  return { agentId: agent.id, slug, plusId: plans.plus, proId: plans.pro, actor: { id: 9000 + agent.id, role: "agent" } };
}

const plusKey = (shop: Shop) => `ref_plus_${shop.slug.replace("refshop", "")}`;
const proKey = (shop: Shop) => `ref_pro_${shop.slug.replace("refshop", "")}`;

async function enable(shop: Shop, overrides: Partial<{ minOrderCents: number; monthlyCap: number; coolingDays: number }> = {}) {
  return m.ref.saveReferralSettings(
    shop.agentId,
    {
      enabled: true,
      couponValidDays: 30,
      coolingDays: overrides.coolingDays ?? 7,
      minOrderCents: overrides.minOrderCents ?? 0,
      monthlyCap: overrides.monthlyCap ?? 10,
      rewards: [
        { planKey: plusKey(shop), amountCents: 1000 },
        { planKey: proKey(shop), amountCents: 5000 },
      ],
    },
    shop.actor,
  );
}

/** 直接插一笔已付款、已发货的单（跳过易支付和卡台），再跑发货后的邀请处理。 */
async function deliveredOrder(
  shop: Shop,
  email: string,
  opts: { referralCode?: string; grossCents?: number; deliveredAt?: string; plan?: "plus" | "pro" } = {},
) {
  const { db, schema } = m;
  seq += 1;
  const plan = opts.plan ?? "plus";
  const now = opts.deliveredAt ?? new Date().toISOString();
  const referralCodeId = opts.referralCode
    ? await m.ref.resolveCheckoutReferralCode(shop.agentId, opts.referralCode)
    : null;
  const [order] = await db
    .insert(schema.storeOrders)
    .values({
      orderNo: `KSREF${seq}`,
      queryTokenHash: `qt${seq}`,
      agentId: shop.agentId,
      planId: plan === "plus" ? shop.plusId : shop.proId,
      planKeySnapshot: plan === "plus" ? plusKey(shop) : proKey(shop),
      productNameSnapshot: plan,
      retailPriceCents: 15000,
      agentCostCents: 11800,
      grossCents: opts.grossCents ?? 15000,
      paymentChannel: "alipay",
      feeRatePpm: 6000,
      fixedFeeCents: 0,
      estimatedPaymentFeeCents: 90,
      finalPaymentFeeCents: 90,
      agentEarningCents: 3110,
      fulfillmentIdempotencyKey: `kaimi-order-ref-${seq}`,
      customerEmail: email,
      payStatus: "paid",
      fulfillStatus: "delivered",
      paidAt: now,
      deliveredAt: now,
      referralCodeId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await m.ref.processDeliveredOrderReferral(order.id);
  return order;
}

async function inviteCodeOf(shop: Shop, email: string) {
  const { db, schema, orm } = m;
  const [row] = await db
    .select()
    .from(schema.agentReferralCodes)
    .where(
      orm.and(
        orm.eq(schema.agentReferralCodes.agentId, shop.agentId),
        orm.eq(schema.agentReferralCodes.ownerEmailHash, m.ref.referralEmailHash(email)),
      ),
    );
  return row?.code ?? null;
}

async function referralOf(orderId: number) {
  const { db, schema, orm } = m;
  const [row] = await db.select().from(schema.agentReferrals).where(orm.eq(schema.agentReferrals.storeOrderId, orderId));
  return row ?? null;
}

async function couponById(id: number) {
  const { db, schema, orm } = m;
  const [row] = await db.select().from(schema.agentReferralCoupons).where(orm.eq(schema.agentReferralCoupons.id, id));
  return row;
}

const later = (days: number) => new Date(Date.now() + days * DAY);

/** 小王首单拿码、小李用码首单、过冷静期发券。返回券。 */
async function invitedCoupon(shop: Shop, inviter: string, invitee: string) {
  await deliveredOrder(shop, inviter);
  const code = (await inviteCodeOf(shop, inviter))!;
  const order = await deliveredOrder(shop, invitee, { referralCode: code });
  await m.ref.issueDueReferralCoupons(50, later(8));
  const referral = await referralOf(order.id);
  return { code, order, referral, coupon: referral?.couponId ? await couponById(referral.couponId) : null };
}

beforeAll(async () => {
  m = {
    db: (await import("@/db")).db,
    schema: await import("@/db/schema"),
    ref: await import("./referrals"),
    orders: await import("./store-orders"),
    config: await import("./config"),
    orm: await import("drizzle-orm"),
  };
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import("drizzle-kit/api");
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson(m.schema as unknown as Record<string, unknown>),
  );
  const { client } = await import("@/db");
  for (const statement of statements) await client.execute(statement);
  await m.config.bootDb();
  // 迁移已经建好两个通道行，这里只开支付宝、定好费率
  await m.db
    .update(m.schema.paymentChannelConfigs)
    .set({ enabled: false });
  await m.db
    .update(m.schema.paymentChannelConfigs)
    .set({ enabled: true, feeRatePpm: 6000, fixedFeeCents: 0 })
    .where(m.orm.eq(m.schema.paymentChannelConfigs.channel, "alipay"));
}, 60_000);

afterAll(async () => {
  (await import("@/db")).client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* Windows 句柄未释放时留着，下次运行开头会删 */
    }
  }
});

describe("设置", () => {
  it("立减超过最多能减不让保存；一个都不填不能开启（23、24）", async () => {
    const shop = await seedShop();
    const settings = await m.ref.getReferralSettings(shop.agentId);
    const plus = settings.plans.find((plan) => plan.planKey === plusKey(shop))!;
    expect(plus.maxCents).toBeGreaterThan(3000);
    expect(plus.maxCents).toBeLessThan(3200);
    const base = { enabled: true, couponValidDays: 30, coolingDays: 7, minOrderCents: 0, monthlyCap: 10 };
    await expect(
      m.ref.saveReferralSettings(shop.agentId, { ...base, rewards: [{ planKey: plusKey(shop), amountCents: plus.maxCents + 1 }] }, shop.actor),
    ).rejects.toThrow("最多只能减");
    await expect(m.ref.saveReferralSettings(shop.agentId, { ...base, rewards: [] }, shop.actor)).rejects.toThrow("至少");
    const saved = await enable(shop);
    expect(saved.enabled).toBe(true);
    expect(saved.firstEnabledAt).toBeTruthy();
  });
});

describe("邀请码", () => {
  it("开启后首单发货生成，再买不变；两家店不同（1、3）", async () => {
    const one = await seedShop();
    const two = await seedShop();
    await enable(one);
    await enable(two);
    const wang = mail("wang1");
    await deliveredOrder(one, wang);
    const first = await inviteCodeOf(one, wang);
    expect(first).toMatch(/^[A-Z0-9]{6}$/);
    await deliveredOrder(one, wang);
    expect(await inviteCodeOf(one, wang)).toBe(first);
    await deliveredOrder(two, wang);
    expect(await inviteCodeOf(two, wang)).not.toBe(first);
  });

  it("活动开启前发货的单不生成（2）", async () => {
    const shop = await seedShop();
    await enable(shop);
    await deliveredOrder(shop, mail("old1"), { deliveredAt: "2020-01-01T00:00:00.000Z" });
    expect(await inviteCodeOf(shop, mail("old1"))).toBeNull();
  });

  it("人工补录过的单（已标处理过）不再处理", async () => {
    const shop = await seedShop();
    await enable(shop);
    const order = await deliveredOrder(shop, mail("manual1"));
    expect(await inviteCodeOf(shop, mail("manual1"))).not.toBeNull();
    // 第二次处理同一单不会出错也不重复
    await m.ref.processDeliveredOrderReferral(order.id);
  });
});

describe("邀请记录和发券", () => {
  it("首单带码进冷静期，到期发券给邀请人（4）", async () => {
    const shop = await seedShop();
    await enable(shop);
    const { referral, coupon } = await invitedCoupon(shop, mail("wang4"), mail("li4"));
    expect(referral?.status).toBe("rewarded");
    expect(coupon?.code).toMatch(/^[A-Z0-9]{10}$/);
    expect(coupon?.ownerEmailHash).toBe(m.ref.referralEmailHash(mail("wang4")));
    expect(JSON.parse(coupon!.rewardsJson)).toEqual({ [plusKey(shop)]: 1000, [proKey(shop)]: 5000 });
  });

  it("冷静期没到不发", async () => {
    const shop = await seedShop();
    await enable(shop);
    await deliveredOrder(shop, mail("wang4b"));
    const order = await deliveredOrder(shop, mail("li4b"), { referralCode: (await inviteCodeOf(shop, mail("wang4b")))! });
    await m.ref.issueDueReferralCoupons(50, later(6));
    expect((await referralOf(order.id))?.status).toBe("cooling");
  });

  it("被邀请人以前付过款、自己邀请自己、别家店的码、低于门槛都不算（5、6、7、8）", async () => {
    const shop = await seedShop();
    const other = await seedShop();
    await enable(shop, { minOrderCents: 10000 });
    await enable(other);
    await deliveredOrder(shop, mail("wang5"));
    const code = (await inviteCodeOf(shop, mail("wang5")))!;
    await deliveredOrder(other, mail("x5"));
    const foreign = (await inviteCodeOf(other, mail("x5")))!;

    // 5：小李以前在这家店付过款（第一单没带码），第二单带码不算
    await deliveredOrder(shop, mail("li5"));
    expect(await referralOf((await deliveredOrder(shop, mail("li5"), { referralCode: code })).id)).toBeNull();
    // 6：Gmail 变体当成同一个人
    await deliveredOrder(shop, mail("wang.six", "gmail.com"));
    const selfCode = (await inviteCodeOf(shop, mail("wang.six", "gmail.com")))!;
    // 自己的第二单，本来就不是首单；换个变体邮箱也是同一个人
    const self = await deliveredOrder(shop, mail("wangsix+alt", "gmail.com"), { referralCode: selfCode });
    expect(await referralOf(self.id)).toBeNull();
    // 7：别家店的码当没带
    const foreignOrder = await deliveredOrder(shop, mail("li7"), { referralCode: foreign });
    expect(foreignOrder.referralCodeId).toBeNull();
    // 8：低于最低实付
    expect(await referralOf((await deliveredOrder(shop, mail("li8"), { referralCode: code, grossCents: 9999 })).id)).toBeNull();
  });

  it("每月上限：超了记「超出上限」，不发券（9）", async () => {
    const shop = await seedShop();
    await enable(shop, { monthlyCap: 1 });
    await deliveredOrder(shop, mail("wang9"));
    const code = (await inviteCodeOf(shop, mail("wang9")))!;
    const first = await deliveredOrder(shop, mail("li9a"), { referralCode: code });
    const second = await deliveredOrder(shop, mail("li9b"), { referralCode: code });
    expect((await referralOf(first.id))?.status).toBe("cooling");
    expect((await referralOf(second.id))?.status).toBe("capped");
    await m.ref.issueDueReferralCoupons(50, later(8));
    expect((await referralOf(second.id))?.couponId).toBeNull();
  });

  it("冷静期内退款作废；发券后退款，没用的券停用（10、11）", async () => {
    const shop = await seedShop();
    await enable(shop);
    await deliveredOrder(shop, mail("wang10"));
    const code = (await inviteCodeOf(shop, mail("wang10")))!;
    const cooling = await deliveredOrder(shop, mail("li10"), { referralCode: code });
    await m.db.transaction((tx) => m.ref.handleReferralRefund(tx, cooling));
    expect((await referralOf(cooling.id))?.status).toBe("void");

    const { order, coupon } = await invitedCoupon(shop, mail("wang11"), mail("li11"));
    await m.db.transaction((tx) => m.ref.handleReferralRefund(tx, order));
    expect((await couponById(coupon!.id)).status).toBe("revoked");
    expect((await referralOf(order.id))?.voidReason).toBe("refunded_after_reward");
  });

  it("活动关闭后：冷静期中的照常发券，新订单不再记录（12）", async () => {
    const shop = await seedShop();
    await enable(shop);
    await deliveredOrder(shop, mail("wang12"));
    const code = (await inviteCodeOf(shop, mail("wang12")))!;
    const pending = await deliveredOrder(shop, mail("li12a"), { referralCode: code });
    await m.ref.saveReferralSettings(
      shop.agentId,
      { enabled: false, couponValidDays: 30, coolingDays: 7, minOrderCents: 0, monthlyCap: 10, rewards: [{ planKey: plusKey(shop), amountCents: 1000 }] },
      shop.actor,
    );
    const after = await deliveredOrder(shop, mail("li12b"), { referralCode: code });
    expect(await referralOf(after.id)).toBeNull();
    await m.ref.issueDueReferralCoupons(50, later(8));
    expect((await referralOf(pending.id))?.status).toBe("rewarded");
  });
});

describe("用券", () => {
  const quote = (shop: Shop, plan: string, code: string, email?: string, quantity = 1) =>
    m.orders.quoteStoreCheckout({ slug: shop.slug, planKey: plan, channel: "alipay", couponCode: code, customerEmail: email, quantity });

  it("本人买券上的商品按快照立减，一单多件只减一次（13、17）", async () => {
    const shop = await seedShop();
    await enable(shop);
    const { coupon } = await invitedCoupon(shop, mail("wang13"), mail("li13"));
    const one = await quote(shop, proKey(shop), coupon!.code, mail("wang13"));
    expect(one.discountCents).toBe(5000);
    expect(one.couponKind).toBe("referral");
    const three = await quote(shop, proKey(shop), coupon!.code, mail("wang13"), 3);
    expect(three.discountCents).toBe(5000);
  });

  it("别人的邮箱、没填邮箱、券上没有的商品都拒绝（14、15）", async () => {
    const shop = await seedShop();
    await enable(shop);
    const { coupon } = await invitedCoupon(shop, mail("wang14"), mail("li14"));
    await expect(quote(shop, proKey(shop), coupon!.code, mail("li14"))).rejects.toThrow("发券的邮箱");
    await expect(quote(shop, proKey(shop), coupon!.code)).rejects.toThrow("先填下单邮箱");
    // 发券后代理把 Plus 从活动里拿掉不影响已发券；这里造一张只有 Pro 的券
    await m.db
      .update(m.schema.agentReferralCoupons)
      .set({ rewardsJson: JSON.stringify({ [proKey(shop)]: 5000 }) })
      .where(m.orm.eq(m.schema.agentReferralCoupons.id, coupon!.id));
    await expect(quote(shop, plusKey(shop), coupon!.code, mail("wang14"))).rejects.toThrow("不能用在这个商品上");
  });

  it("发券后降价会亏本：自动封底（16）", async () => {
    const shop = await seedShop();
    await enable(shop);
    const { coupon } = await invitedCoupon(shop, mail("wang16"), mail("li16"));
    await m.db
      .update(m.schema.agentPlanPrices)
      .set({ retailPriceCents: 12300 })
      .where(m.orm.and(m.orm.eq(m.schema.agentPlanPrices.agentId, shop.agentId), m.orm.eq(m.schema.agentPlanPrices.planId, shop.plusId)));
    const result = await quote(shop, plusKey(shop), coupon!.code, mail("wang16"));
    expect(result.discountCents).toBeGreaterThan(0);
    expect(result.discountCents).toBeLessThan(1000);
  });

  it("锁券只能锁一次；关单退回；付款记已用；用券单退款券回来（18、19、20）", async () => {
    const shop = await seedShop();
    await enable(shop);
    const { coupon } = await invitedCoupon(shop, mail("wang18"), mail("li18"));
    const id = coupon!.id;
    await m.db.transaction((tx) => m.ref.reserveReferralCoupon(tx, id, 501));
    await expect(m.db.transaction((tx) => m.ref.reserveReferralCoupon(tx, id, 502))).rejects.toThrow("刚被用掉");
    await expect(quote(shop, proKey(shop), coupon!.code, mail("wang18"))).rejects.toThrow("未付款订单");

    await m.db.transaction((tx) => m.ref.releaseReferralCouponForClosedOrder(tx, { id: 501, referralCouponId: id }));
    expect((await couponById(id)).status).toBe("unused");

    await m.db.transaction((tx) => m.ref.reserveReferralCoupon(tx, id, 503));
    await m.db.transaction((tx) => m.ref.markReferralCouponUsed(tx, { id: 503, referralCouponId: id, couponDiscountCents: 5000 }));
    expect(await couponById(id)).toMatchObject({ status: "used", usedOrderId: 503, usedDiscountCents: 5000 });
    await expect(quote(shop, proKey(shop), coupon!.code, mail("wang18"))).rejects.toThrow("用过");

    await m.db.transaction((tx) => m.ref.handleReferralRefund(tx, { id: 503, referralCouponId: id }));
    expect((await couponById(id)).status).toBe("unused");
  });

  it("过期的券拒绝，定时任务改成已过期（21）", async () => {
    const shop = await seedShop();
    await enable(shop);
    const { coupon } = await invitedCoupon(shop, mail("wang21"), mail("li21"));
    await m.db
      .update(m.schema.agentReferralCoupons)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
      .where(m.orm.eq(m.schema.agentReferralCoupons.id, coupon!.id));
    await expect(quote(shop, proKey(shop), coupon!.code, mail("wang21"))).rejects.toThrow("过期");
    await m.ref.expireReferralCoupons();
    expect((await couponById(coupon!.id)).status).toBe("expired");
  });
});

describe("查看和权限", () => {
  it("查单页能看到邀请卡片和自己的券", async () => {
    const shop = await seedShop();
    await enable(shop);
    const { code, coupon } = await invitedCoupon(shop, mail("wangv"), mail("liv"));
    const view = await m.ref.buyerReferralView({ agentId: shop.agentId, customerEmail: mail("wangv") }, "https://shop.test");
    expect(view?.invite?.link).toBe(`https://shop.test/s/${shop.slug}?ref=${code}`);
    expect(view?.invite?.rewardedCount).toBe(1);
    expect(view?.invite?.rule).toContain("Plus 立减 ¥10.00");
    expect(view?.coupons.map((row) => row.code)).toEqual([coupon!.code]);
    // 被邀请人看不到别人的券
    const other = await m.ref.buyerReferralView({ agentId: shop.agentId, customerEmail: mail("liv") }, "https://shop.test");
    expect(other?.coupons ?? []).toEqual([]);
  });

  it("代理只能停自己店的券；管理员能关活动（26）", async () => {
    const shop = await seedShop();
    const other = await seedShop();
    await enable(shop);
    const { coupon } = await invitedCoupon(shop, mail("wang26"), mail("li26"));
    await expect(
      m.ref.revokeReferralCoupon({ couponId: coupon!.id, reason: "x", agentId: other.agentId }, other.actor),
    ).rejects.toThrow("只有未使用");
    await m.ref.revokeReferralCoupon({ couponId: coupon!.id, reason: "刷券", agentId: shop.agentId }, shop.actor);
    expect((await couponById(coupon!.id)).status).toBe("revoked");

    await m.ref.adminDisableReferral(shop.agentId, { id: 1, role: "super_admin" });
    const settings = await m.ref.getReferralSettings(shop.agentId);
    expect(settings.enabled).toBe(false);
    expect(settings.disabledByAdminAt).toBeTruthy();
    await expect(enable(shop)).rejects.toThrow("平台关闭");

    const list = await m.ref.listReferralInviters(shop.agentId, {});
    expect(list.list[0]).toMatchObject({ email: mail("wang26"), rewardedCount: 1, couponCount: 1 });
    const overview = await m.ref.adminReferralOverview();
    expect(overview.agents.some((row) => row.agentId === shop.agentId && row.disabledByAdmin)).toBe(true);
  });
});

describe("第二期：邮件和 Telegram", () => {
  it("记邀请、发券时通知绑了 Telegram 的代理；没绑不发", async () => {
    const shop = await seedShop();
    await m.db.update(m.schema.agents).set({ telegramChatId: "777001" }).where(m.orm.eq(m.schema.agents.id, shop.agentId));
    await enable(shop);
    sent.telegram.length = 0;
    const { coupon } = await invitedCoupon(shop, mail("wangtg"), mail("litg"));
    const mine = sent.telegram.filter((row) => row.chatId === "777001");
    expect(mine).toHaveLength(2);
    expect(mine[0].text).toContain("首单成交 ¥150.00");
    expect(mine[0].text).not.toContain(mail("litg"));
    expect(mine[1].text).toContain(coupon!.code);

    const quiet = await seedShop();
    await enable(quiet);
    sent.telegram.length = 0;
    await invitedCoupon(quiet, mail("wangq"), mail("liq"));
    expect(sent.telegram).toHaveLength(0);
  });

  it("发券后给邀请人发得券邮件，只发一次", async () => {
    const shop = await seedShop();
    await enable(shop);
    sent.mailMode = "sent";
    sent.mails.length = 0;
    const { coupon } = await invitedCoupon(shop, mail("wangmail"), mail("limail"));
    expect(sent.mails).toHaveLength(1);
    expect(sent.mails[0]).toMatchObject({ to: mail("wangmail"), subject: "测试店 邀请券到账" });
    expect(sent.mails[0].text).toContain(coupon!.code);
    expect(sent.mails[0].text).toContain("Plus 立减 ¥10.00");
    expect((await couponById(coupon!.id)).noticeStatus).toBe("sent");
    await m.ref.retryReferralCouponNotices();
    expect(sent.mails).toHaveLength(1);
  });

  it("邮件没开记 skipped；发信失败记 failed，定时任务重试", async () => {
    const shop = await seedShop();
    await enable(shop);
    sent.mailMode = "skip";
    const skipped = (await invitedCoupon(shop, mail("wangskip"), mail("liskip"))).coupon!;
    expect((await couponById(skipped.id)).noticeStatus).toBe("skipped");

    sent.mailMode = "throw";
    const failed = (await invitedCoupon(shop, mail("wangfail"), mail("lifail"))).coupon!;
    expect(await couponById(failed.id)).toMatchObject({ noticeStatus: "failed", noticeAttempts: 1 });
    sent.mailMode = "sent";
    sent.mails.length = 0;
    await m.ref.retryReferralCouponNotices();
    expect((await couponById(failed.id)).noticeStatus).toBe("sent");
    expect(sent.mails.map((row) => row.to)).toEqual([mail("wangfail")]);
  });

  it("到期前 3 天提醒一次；有效期太短的不提醒；用掉的不提醒", async () => {
    const shop = await seedShop();
    await enable(shop);
    sent.mailMode = "sent";
    const { coupon } = await invitedCoupon(shop, mail("wangrm"), mail("lirm"));
    const short = (await invitedCoupon(shop, mail("wangrs"), mail("lirs"))).coupon!;
    const used = (await invitedCoupon(shop, mail("wangru"), mail("liru"))).coupon!;
    const set = (id: number, values: Partial<typeof m.schema.agentReferralCoupons.$inferInsert>) =>
      m.db.update(m.schema.agentReferralCoupons).set(values).where(m.orm.eq(m.schema.agentReferralCoupons.id, id));
    const inTwoDays = new Date(Date.now() + 2 * DAY).toISOString();
    await set(coupon!.id, { createdAt: new Date(Date.now() - 28 * DAY).toISOString(), expiresAt: inTwoDays });
    await set(short.id, { expiresAt: inTwoDays });
    await set(used.id, { createdAt: new Date(Date.now() - 28 * DAY).toISOString(), expiresAt: inTwoDays, status: "used" });
    sent.mails.length = 0;
    await m.ref.sendReferralCouponReminders();
    expect(sent.mails.map((row) => row.to)).toEqual([mail("wangrm")]);
    expect(sent.mails[0].subject).toBe("测试店 邀请券快到期了");
    expect((await couponById(short.id)).remindStatus).toBe("skipped");
    await m.ref.sendReferralCouponReminders();
    expect(sent.mails).toHaveLength(1);
  });

  it("发货邮件末尾的邀请段：有公网地址、有邀请码才有", async () => {
    const shop = await seedShop();
    await enable(shop);
    const order = await deliveredOrder(shop, mail("wanglines"));
    await m.config.setSetting("public_base_url", "");
    expect(await m.ref.referralInviteMailBlock(order)).toBeNull();
    await m.config.setSetting("public_base_url", "https://shop.example.com");
    const block = await m.ref.referralInviteMailBlock({ ...order, referralProcessedAt: "x" });
    const code = await inviteCodeOf(shop, mail("wanglines"));
    expect(block?.link).toBe(`https://shop.example.com/s/${shop.slug}?ref=${code}`);
    expect(block?.code).toBe(code);
  });
});
