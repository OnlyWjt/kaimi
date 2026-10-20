"use client";

import { MailTemplateEditor } from "@/components/mail-template-editor";

/** 「通知」页的邮件模板：平台模板、允许代理修改、代理自定义的模板。 */
export function AdminMailTemplates() {
  return (
    <section className="km-panel space-y-1">
      <div>
        <h2 className="text-xl font-semibold">邮件模板</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          以店铺名义发给买家的邮件。这里改的是平台模板：没自定义的代理用它；打开「允许代理修改」的，代理可以在自己后台另存一份，之后这里再改也不影响他们。
        </p>
      </div>
      <MailTemplateEditor mode="admin" />
    </section>
  );
}
