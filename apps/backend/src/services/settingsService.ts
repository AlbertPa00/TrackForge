// Sprint 024 — global SystemSetting helpers. Instance-level config lives in
// the SystemSetting table; missing keys fall back to documented defaults.
// 021 hangs module toggles off the same mechanism.

import { prisma } from '../prisma.js';
import { DEFAULT_TIME_CONFIG, type TimeTrackingConfig } from '../lib/duration.js';

const TT_KEY = 'timetracking';

export async function getSetting<T>(key: string): Promise<T | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return (row?.value as T) ?? null;
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: value as object },
    update: { value: value as object },
  });
}

export async function getTimeTrackingConfig(): Promise<TimeTrackingConfig> {
  const stored = await getSetting<Partial<TimeTrackingConfig>>(TT_KEY);
  return { ...DEFAULT_TIME_CONFIG, ...(stored ?? {}) };
}

export async function setTimeTrackingConfig(patch: Partial<TimeTrackingConfig>): Promise<TimeTrackingConfig> {
  const next = { ...(await getTimeTrackingConfig()), ...patch };
  await putSetting(TT_KEY, next);
  return next;
}

// ---- 021 — instance module toggles ----

export interface ModuleToggles {
  ai: boolean;
  automation: boolean;
  devPanel: boolean;
  importers: boolean;
}

const MODULES_KEY = 'modules';
export const DEFAULT_MODULES: ModuleToggles = {
  ai: true,
  automation: true,
  devPanel: false,
  importers: true,
};

export async function getModuleToggles(): Promise<ModuleToggles> {
  const stored = await getSetting<Partial<ModuleToggles>>(MODULES_KEY);
  return { ...DEFAULT_MODULES, ...(stored ?? {}) };
}

export async function setModuleToggles(patch: Partial<ModuleToggles>): Promise<ModuleToggles> {
  const next = { ...(await getModuleToggles()), ...patch };
  await putSetting(MODULES_KEY, next);
  return next;
}

/** Cheap gate for feature checks (ai routes, importer registry, dev panel). */
export async function moduleEnabled(name: keyof ModuleToggles): Promise<boolean> {
  return (await getModuleToggles())[name];
}
