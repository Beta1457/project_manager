import { createContext, useContext } from 'react';
import type { Project } from './types';

// Kept apart from project.tsx (provider and forms) so hooks.ts can use it without an import cycle.

export interface ProjectContextValue {
  project: Project;
  projects: Project[];
  /** Opens another project; `task` (one of that project's) opens in its dock there. */
  switchTo: (id: number, opts?: { task?: number | string }) => void;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject is only available inside ProjectProvider');
  return ctx;
}

/** The current project's id: part of the cache key of everything listed per project. */
export const useProjectId = (): number => useProject().project.id;
