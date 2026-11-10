// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Pure model for the application lifecycle explainer.

export type AppLifecycleState =
  | "proposed"
  | "pending"
  | "active"
  | "suspended"
  | "revoked";

export type LifecycleActor = "requester" | "approver";
export type LifecycleActionKind =
  | "proposed"
  | "approved"
  | "selfApprovalBlocked"
  | "suspended"
  | "reactivated"
  | "revoked";

export interface LifecycleLogEntry {
  id: number;
  kind: LifecycleActionKind;
}

export interface AppLifecycleSimState {
  status: AppLifecycleState;
  actor: LifecycleActor;
  log: LifecycleLogEntry[];
  seq: number;
}

export type AppLifecycleAction =
  | { type: "setActor"; actor: LifecycleActor }
  | { type: "propose" }
  | { type: "approve"; byRequester: boolean }
  | { type: "suspend" }
  | { type: "reactivate" }
  | { type: "revoke" }
  | { type: "reset" };

export const LIFECYCLE_STATES: AppLifecycleState[] = [
  "proposed",
  "pending",
  "active",
  "suspended",
  "revoked",
];

const LOG_LIMIT = 7;

export function initialAppLifecycleState(): AppLifecycleSimState {
  return { status: "proposed", actor: "requester", log: [], seq: 0 };
}

function withLog(
  state: AppLifecycleSimState,
  kind: LifecycleActionKind
): AppLifecycleSimState {
  const id = state.seq + 1;
  return {
    ...state,
    seq: id,
    log: [{ id, kind }, ...state.log].slice(0, LOG_LIMIT),
  };
}

export function canApprove(state: AppLifecycleSimState): boolean {
  return state.status === "pending";
}

export function appLifecycleReducer(
  state: AppLifecycleSimState,
  action: AppLifecycleAction
): AppLifecycleSimState {
  switch (action.type) {
    case "setActor":
      return { ...state, actor: action.actor };
    case "propose":
      if (state.status !== "proposed") return state;
      return withLog({ ...state, status: "pending" }, "proposed");
    case "approve":
      if (state.status !== "pending") return state;
      if (action.byRequester) return withLog(state, "selfApprovalBlocked");
      return withLog({ ...state, status: "active" }, "approved");
    case "suspend":
      if (state.status !== "active") return state;
      return withLog({ ...state, status: "suspended" }, "suspended");
    case "reactivate":
      if (state.status !== "suspended") return state;
      return withLog({ ...state, status: "active" }, "reactivated");
    case "revoke":
      if (state.status === "revoked") return state;
      return withLog({ ...state, status: "revoked" }, "revoked");
    case "reset":
      return initialAppLifecycleState();
  }
}
