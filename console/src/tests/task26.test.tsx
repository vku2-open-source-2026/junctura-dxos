// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "../locales/i18n";
import { WorkflowSim } from "../components/explainers/WorkflowSim";
import {
  initialWorkflowState,
  stepStates,
  workflowReducer,
} from "../components/explainers/workflowSimModel";

function renderSim() {
  return render(
    <I18nProvider>
      <WorkflowSim />
    </I18nProvider>
  );
}

function activeStep(): HTMLElement {
  const active = screen
    .getAllByRole("listitem")
    .find((item) => item.getAttribute("aria-current") === "step");
  if (!active) throw new Error("no active workflow step");
  return active;
}

describe("Workflow step model", () => {
  it("moves through automatic and person steps", () => {
    let state = initialWorkflowState();
    expect(state).toEqual({ index: 0, phase: "idle" });
    state = workflowReducer(state, { type: "advance" });
    expect(state).toEqual({ index: 1, phase: "waiting" });
    state = workflowReducer(state, { type: "approve" });
    expect(state).toEqual({ index: 2, phase: "waiting" });
    state = workflowReducer(state, { type: "approve" });
    expect(state.phase).toBe("done");
    expect(Object.values(stepStates(state))).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("stops at the rejected step and leaves later steps untouched", () => {
    const waiting = workflowReducer(initialWorkflowState(), { type: "advance" });
    const rejected = workflowReducer(waiting, { type: "reject" });
    expect(rejected.phase).toBe("rejected");
    expect(stepStates(rejected)).toEqual({
      submit: "done",
      review: "cancelled",
      receive: "pending",
      done: "pending",
    });
    expect(workflowReducer(rejected, { type: "advance" })).toBe(rejected);
  });
});

describe("WorkflowSim step row", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows each step with the person responsible", () => {
    renderSim();
    const row = screen.getByRole("list", { name: /Gửi hồ sơ/ });
    expect(within(row).getByText("Trạm y tế")).toBeInTheDocument();
    expect(within(row).getByText("Bác sĩ bệnh viện")).toBeInTheDocument();
    expect(within(row).getByText("Bệnh viện")).toBeInTheDocument();
    expect(within(row).getByText("Hoàn tất")).toBeInTheDocument();
  });

  it("highlights the waiting step and finishes after two approvals", () => {
    renderSim();
    fireEvent.click(screen.getByRole("button", { name: "Chạy thử từng bước" }));

    let step = activeStep();
    expect(within(step).getByText("Duyệt")).toBeInTheDocument();
    expect(within(step).getByText("Bác sĩ bệnh viện")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    step = activeStep();
    expect(within(step).getByText("Tiếp nhận")).toBeInTheDocument();
    expect(within(step).getByText("Bệnh viện")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    expect(
      screen.getByText("Quy trình đã hoàn thành.")
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("listitem").every(
        (item) => item.getAttribute("aria-current") === null
      )
    ).toBe(true);
  });
});
