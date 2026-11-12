import { createContext, useContext } from 'react';
import type { Project } from './types';

// Kept apart from project.tsx (provider and forms) so hooks.ts can use it without an import cycle.

export interface ProjectContextValue {
  project: Project;
  projects: Project[];
  /** Opens another project. `keepTask` keeps the open task (one from that project) on screen. */
  switchTo: (id: number, opts?: { keepTask?: boolean }) => void;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject is only available inside ProjectProvider');
  return ctx;
}

/** The current project's id: part of the cache key of everything listed per project. */
export const useProjectId = (): number => useProject().project.id;
