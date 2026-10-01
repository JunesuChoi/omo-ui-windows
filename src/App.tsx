import { useEffect, useState } from "react";
import type { BridgeStatus } from "../shared/ipc";

export function App() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);

  useEffect(() => {
    const bridge = window.omo;
    if (!bridge) return undefined;
    let current = true;
    void bridge.getStatus().then((next) => {
      if (current) setStatus(next);
    });
    const unsubscribe = bridge.onStatus(setStatus);
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  return (
    <main>
      <h1>OmO UI</h1>
      {status !== null && (
        <dl>
          <dt>Bridge state</dt>
          <dd>{status.state}</dd>
          <dt>omo path</dt>
          <dd>{status.omo?.path ?? "none"}</dd>
          <dt>omo version</dt>
          <dd>{status.omo?.version ?? "none"}</dd>
          <dt>Message</dt>
          <dd>{status.message ?? ""}</dd>
        </dl>
      )}
    </main>
  );
}
