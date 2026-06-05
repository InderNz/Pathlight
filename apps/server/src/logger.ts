export const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", msg, ts: new Date().toISOString(), ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: "warn", msg, ts: new Date().toISOString(), ...meta })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: "error", msg, ts: new Date().toISOString(), ...meta })),
};
