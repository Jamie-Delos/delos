import { EventEmitter } from "node:events";

// Tiny in-process bus: the ingester emits, the WebSocket handler fans out to connected clients.
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export type Update =
  | { type: "coin"; data: unknown }
  | { type: "trade"; data: unknown }
  | { type: "graduate"; data: unknown };

export const publish = (u: Update) => bus.emit("update", u);
