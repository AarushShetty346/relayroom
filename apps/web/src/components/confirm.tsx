import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "./ui";

interface Req {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

let push: ((r: Req) => void) | null = null;

/** Promise-based confirmation dialog for risky actions. */
export function confirmAction(opts: Omit<Req, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    if (!push) return resolve(window.confirm(typeof opts.body === "string" ? opts.body : opts.title));
    push({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => {
    push = setReq;
    return () => {
      push = null;
    };
  }, []);
  if (!req) return null;
  const done = (ok: boolean) => {
    req.resolve(ok);
    setReq(null);
  };
  return (
    <Modal
      title={req.title}
      onClose={() => done(false)}
      footer={
        <>
          <button className="btn" onClick={() => done(false)}>Cancel</button>
          <button className={req.danger ? "btn danger" : "btn primary"} onClick={() => done(true)}>
            {req.confirmLabel ?? "Confirm"}
          </button>
        </>
      }
    >
      <div className="small">{req.body}</div>
    </Modal>
  );
}
