// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import {
  ArrowRight,
  Link2,
  ScrollText,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../common/Button";
import { Badge } from "../common/Badge";
import { JuncturaLogo } from "../common/JuncturaLogo";
import { PublicControls } from "../common/PublicControls";
import { useI18n } from "../../locales/i18n";
import type { ScreenId } from "../../constants/modules";
import { PlatformLayersDiagram } from "./landing/PlatformLayersDiagram";

interface LandingScreenProps {
  onNavigate: (screen: ScreenId) => void;
}

const BENEFIT_ICONS: LucideIcon[] = [ShieldCheck, Link2, ScrollText];

export const LandingScreen: React.FC<LandingScreenProps> = ({ onNavigate }) => {
  const { t } = useI18n();

  const scrollTo = (id: string) => {
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-app-bg text-stone-ink transition-colors dark:bg-[#0D1A22] dark:text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur dark:border-[#243843] dark:bg-[#0D1A22]/90">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3">
          <button
            type="button"
            onClick={() => onNavigate("welcome")}
            className="shrink-0"
            aria-label={t.common.appName}
          >
            <JuncturaLogo size={30} showText={true} />
          </button>
          <nav
            className="ml-2 hidden items-center gap-1 md:flex"
            aria-label={t.common.appName}
          >
            <button
              type="button"
              onClick={() => scrollTo("landing-benefits")}
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-stone-ink dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              {t.landing.navBenefits}
            </button>
            <button
              type="button"
              onClick={() => scrollTo("landing-how")}
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-stone-ink dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              {t.landing.navHow}
            </button>
            <button
              type="button"
              onClick={() => scrollTo("landing-capabilities")}
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-stone-ink dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              {t.landing.navCapabilities}
            </button>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <PublicControls />
            <Button
              variant="primary"
              size="sm"
              onClick={() => onNavigate("login")}
            >
              {t.landing.login}
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 lg:grid-cols-[5fr_6fr] lg:py-24">
          <div>
            <Badge variant="teal" className="mb-5">
              <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t.common.tagline}
            </Badge>
            <h1 className="max-w-xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
              {t.landing.heroTitle}
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-600 dark:text-slate-300 sm:text-lg">
              {t.landing.heroLead}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button
                variant="primary"
                size="lg"
                onClick={() => onNavigate("login")}
                rightIcon={<ArrowRight className="h-4 w-4" aria-hidden="true" />}
              >
                {t.landing.login}
              </Button>
            </div>
            <p className="mt-5 text-sm text-slate-500 dark:text-slate-400">
              {t.landing.heroNote}
            </p>
          </div>

          <div className="rounded-md border border-slate-200/80 bg-white p-6 shadow-lg dark:border-[#243843] dark:bg-[#13242D]">
            <PlatformLayersDiagram />
          </div>
        </section>

        <section
          id="landing-benefits"
          className="border-t border-slate-200/70 dark:border-[#243843]/60"
        >
          <div className="mx-auto max-w-6xl px-5 py-16">
            <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
              {t.landing.benefitsTitle}
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600 dark:text-slate-300">
              {t.landing.benefitsLead}
            </p>
            <div className="mt-10 grid gap-5 sm:grid-cols-3">
              {t.landing.benefits.map((benefit, index) => {
                const Icon = BENEFIT_ICONS[index] ?? ShieldCheck;
                return (
                  <div
                    key={benefit.title}
                    className="rounded-md border border-slate-200/80 bg-white p-5 dark:border-[#243843] dark:bg-[#13242D]"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <h3 className="mt-4 text-base font-semibold">
                      {benefit.title}
                    </h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                      {benefit.desc}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section
          id="landing-how"
          className="border-t border-slate-200/70 bg-white/50 dark:border-[#243843]/60 dark:bg-[#0D1A22]/40"
        >
          <div className="mx-auto max-w-6xl px-5 py-16">
            <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
              {t.landing.howTitle}
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600 dark:text-slate-300">
              {t.landing.howLead}
            </p>
            <ol className="mt-10 grid gap-6 sm:grid-cols-3">
              {t.landing.steps.map((step, index) => (
                <li key={step.title} className="relative">
                  <span className="text-4xl font-bold leading-none tracking-tight text-[var(--accent)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-3 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {step.desc}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="landing-capabilities"
          className="border-t border-slate-200/70 dark:border-[#243843]/60"
        >
          <div className="mx-auto max-w-6xl px-5 py-16">
            <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
              {t.landing.layersTitle}
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600 dark:text-slate-300">
              {t.landing.layersLead}
            </p>
            <div className="mt-10">
              <PlatformLayersDiagram />
            </div>
          </div>
        </section>

        <section className="border-t border-slate-200/70 bg-[#172F3D] text-white dark:border-[#243843]/60 dark:bg-[#0D1A22]">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-5 py-14 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                {t.landing.ctaTitle}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-300">
                {t.landing.ctaLead}
              </p>
            </div>
            <Button
              variant="primary"
              size="lg"
              onClick={() => onNavigate("login")}
            >
              {t.landing.login}
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200/70 dark:border-[#243843]/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-slate-500 dark:text-slate-400">
          <span>© 2026 Junctura Contributors · Apache-2.0</span>
          <span>{t.landing.footerNote}</span>
        </div>
      </footer>
    </div>
  );
};
