import { AgentApiPanel } from "@/components/agent-api-panel";

export default function AgentApiPage() {
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>开放 API</h1>
          <p>把订单、卡密和兑换接到你自己的程序里。Key 只属于你这家店。</p>
        </div>
      </header>
      <AgentApiPanel />
    </>
  );
}
