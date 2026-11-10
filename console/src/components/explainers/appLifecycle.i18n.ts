// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  AppLifecycleState,
  LifecycleActionKind,
  LifecycleActor,
} from "./appLifecycleModel";

const vi = {
  title: "Thử dòng đời một ứng dụng",
  subtitle: "Đi qua từng trạng thái để thấy ai làm gì. Người đề xuất không thể tự bấm duyệt.",
  appName: "Ứng dụng: Thư viện số",
  actorTitle: "Bạn đang là",
  actors: { requester: "Người đề xuất", approver: "Người duyệt" } as Record<LifecycleActor, string>,
  states: {
    proposed: "Đề xuất",
    pending: "Chờ người thứ hai duyệt",
    active: "Hoạt động",
    suspended: "Tạm ngưng",
    revoked: "Thu hồi",
  } as Record<AppLifecycleState, string>,
  stateHelp: {
    proposed: "Ứng dụng vừa được đề xuất. Người đề xuất gửi hồ sơ để chuyển sang bước chờ duyệt.",
    pending: "Đang chờ một người khác duyệt. Nếu bạn là người đề xuất, nút Duyệt bị khóa.",
    active: "Ứng dụng đang hoạt động và nhận lệnh gọi. Có thể tạm ngưng khi cần.",
    suspended: "Ứng dụng bị tạm ngưng. Mọi lệnh gọi của ứng dụng bị chặn ngay.",
    revoked: "Ứng dụng đã bị thu hồi. Đây là trạng thái cuối cùng, không thể mở lại.",
  } as Record<AppLifecycleState, string>,
  propose: "Gửi đề xuất",
  approve: "Duyệt",
  suspend: "Tạm ngưng",
  reactivate: "Kích hoạt lại",
  revoke: "Thu hồi",
  reset: "Làm lại",
  selfBlocked: "Nút Duyệt bị khóa: người đề xuất không thể tự duyệt yêu cầu của mình.",
  blockedCalls: "Ứng dụng đang tạm ngưng — lệnh gọi bị chặn",
  junctura: "Junctura",
  logTitle: "Nhật ký",
  logEmpty: "Chưa có thao tác nào.",
  log: {
    proposed: "Người đề xuất gửi hồ sơ ứng dụng.",
    approved: "Người duyệt thứ hai chấp thuận; ứng dụng chuyển sang Hoạt động.",
    selfApprovalBlocked: "Không cho phép: người đề xuất tự duyệt yêu cầu của mình.",
    suspended: "Ứng dụng bị tạm ngưng; mọi lệnh gọi bị chặn.",
    reactivated: "Ứng dụng được kích hoạt lại.",
    revoked: "Ứng dụng bị thu hồi; đây là trạng thái cuối cùng.",
  } as Record<LifecycleActionKind, string>,
  diagramLabel: (status: string) => `Sơ đồ dòng đời ứng dụng. Trạng thái hiện tại: ${status}.`,
};

export type AppLifecycleStrings = typeof vi;

const en: AppLifecycleStrings = {
  title: "Try an application's lifecycle",
  subtitle: "Move through each state to see who does what. The proposer cannot approve their own request.",
  appName: "Application: Digital Library",
  actorTitle: "You are",
  actors: { requester: "Requester", approver: "Approver" },
  states: {
    proposed: "Proposed",
    pending: "Awaiting a second person",
    active: "Active",
    suspended: "Suspended",
    revoked: "Revoked",
  },
  stateHelp: {
    proposed: "The application was just proposed. The requester submits it for approval.",
    pending: "Waiting for a different person to approve. If you are the requester, the Approve button is locked.",
    active: "The application is running and receiving calls. It can be suspended when needed.",
    suspended: "The application is suspended. Every call from it is blocked immediately.",
    revoked: "The application is revoked. This is the final state and cannot be reopened.",
  },
  propose: "Submit proposal",
  approve: "Approve",
  suspend: "Suspend",
  reactivate: "Reactivate",
  revoke: "Revoke",
  reset: "Start over",
  selfBlocked: "Approve is locked: the proposer cannot approve their own request.",
  blockedCalls: "Application suspended — calls are blocked",
  junctura: "Junctura",
  logTitle: "Log",
  logEmpty: "No action yet.",
  log: {
    proposed: "The requester submitted the application.",
    approved: "A second approver accepted it; the application is now Active.",
    selfApprovalBlocked: "Not allowed: the proposer cannot approve their own request.",
    suspended: "The application was suspended; every call is blocked.",
    reactivated: "The application was reactivated.",
    revoked: "The application was revoked; this is the final state.",
  },
  diagramLabel: (status) => `Application lifecycle diagram. Current state: ${status}.`,
};

export const APP_LIFECYCLE_STRINGS: Record<"vi" | "en", AppLifecycleStrings> = { vi, en };
