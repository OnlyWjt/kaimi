export default function AgentLoading() {
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>正在打开</h1>
          <p>侧栏先留着，这一面的数字马上出来。</p>
        </div>
      </header>
      <div className="km-acp-kpis">
        {["一", "二", "三", "四"].map((item) => (
          <div key={item} className="km-acp-kpi is-wait">
            <span>加载中</span>
            <strong>…</strong>
          </div>
        ))}
      </div>
    </>
  );
}
