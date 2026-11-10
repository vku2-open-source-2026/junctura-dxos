// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

export type DocsGroupId = "start" | "roles" | "concepts" | "reference" | "help";

export type DocsSectionId =
  | "quickStart"
  | "roleAdmin"
  | "roleAppManager"
  | "roleAuditor"
  | "conceptApplication"
  | "conceptCapability"
  | "conceptPermission"
  | "conceptTwoPerson"
  | "conceptConsent"
  | "conceptEmergency"
  | "conceptHashChain"
  | "api"
  | "tryIt"
  | "faq";

export type DocBlock =
  | { kind: "lead"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "code"; code: string; language?: string }
  | { kind: "callout"; title: string; text: string }
  | { kind: "links"; items: { label: string; path: string }[] }
  | { kind: "terms"; items: { term: string; description: string }[] }
  | { kind: "faq"; items: { question: string; answer: string }[] };

export interface DocSection {
  title: string;
  intro?: string;
  blocks: DocBlock[];
}
