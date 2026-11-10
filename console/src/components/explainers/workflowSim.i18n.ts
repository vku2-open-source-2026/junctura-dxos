// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { WorkflowPhase } from "./workflowSimModel";

const vi = {
  title: "Chạy thử quy trình duyệt học bổng",
  subtitle: "Bấm “Chạy thử từng bước” để xem hồ sơ đi qua các bước. Quy trình dừng lại khi cần người duyệt.",
  run: "Chạy thử từng bước",
  approve: "Duyệt",
  reject: "Từ chối",
  reset: "Làm lại",
  waiting: "Đang dừng ở bước cần người duyệt. Chọn Duyệt để đi tiếp hoặc Từ chối để dừng.",
  done: "Quy trình đã hoàn thành.",
  rejected: "Quy trình đã bị từ chối và dừng lại.",
  idle: "Sẵn sàng chạy thử. Hồ sơ chưa đi qua bước nào.",
  current: "Đang ở bước {name}",
  diagramAria: "Sơ đồ quy trình duyệt học bổng",
  phase: {
    idle: "Chưa chạy",
    running: "Đang chạy",
    waiting: "Chờ duyệt",
    done: "Hoàn thành",
    rejected: "Bị từ chối",
  } as Record<WorkflowPhase, string>,
};

export type WorkflowSimStrings = typeof vi;

const en: WorkflowSimStrings = {
  title: "Try the scholarship review workflow",
  subtitle: "Select “Run the next step” to move the record through its steps. The workflow stops wherever a person must decide.",
  run: "Run the next step",
  approve: "Approve",
  reject: "Reject",
  reset: "Start over",
  waiting: "Paused at a step that needs a person. Choose Approve to continue or Reject to stop.",
  done: "The workflow is complete.",
  rejected: "The workflow was rejected and stopped.",
  idle: "Ready to run. The record has not moved yet.",
  current: "Now at {name}",
  diagramAria: "Scholarship review workflow diagram",
  phase: { idle: "Not started", running: "Running", waiting: "Waiting", done: "Complete", rejected: "Rejected" },
};

export const WORKFLOW_SIM_STRINGS: Record<"vi" | "en", WorkflowSimStrings> = { vi, en };
