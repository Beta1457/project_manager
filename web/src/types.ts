export interface Status {
  id: string;
  label: string;
  color: string;
}

export interface Category {
  id: number;
  name: string;
  color: string;
}

export interface Project {
  id: number;
  /** Task key prefix, e.g. "APP" for APP-12. Unique on the server. */
  key: string;
  name: string;
  color: string;
  taskCount: number;
  openTaskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Meta {
  project: Pick<Project, 'id' | 'key' | 'name' | 'color'>;
  statuses: Status[];
  priorities: string[];
  types: string[];
  typeColors: Record<string, string>;
  categories: Category[];
}

export interface Task {
  /** Unique on the server (used in ?task= links); `number` counts up per project. */
  id: number;
  key: string;
  number: number;
  projectId: number;
  title: string;
  description: string;
  type: string;
  status: string;
  statusLabel: string;
  priority: string;
  epochId: number | null;
  epochName: string | null;
  epochColor: string | null;
  folderId: number | null;
  estimateMinutes: number | null;
  loggedMinutes: number;
  timerRunning: boolean;
  checklist: { done: number; total: number };
  /** Tasks blocking this one that haven't reached Alpha Complete. */
  openBlockers: number;
  categories: Category[];
  sortOrder: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistItem {
  id: number;
  text: string;
  done: boolean;
}

export interface Activity {
  id: number;
  actor: string;
  kind: string;
  message: string;
  createdAt: string;
}

export interface TaskLink {
  id: number;
  kind: 'relates' | 'blocks' | 'duplicates';
  outgoing: boolean;
  /** How the link reads from this task: "blocks", "blocked by", "duplicates", "duplicated by", "relates to". */
  label: string;
  task: { id: number; key: string; title: string; status: string; statusLabel: string; type: string };
}

export interface TaskDetail extends Task {
  checklistItems: ChecklistItem[];
  links: TaskLink[];
  activity: Activity[];
}

export interface Epoch {
  id: number;
  folderId: number | null;
  name: string;
  description: string;
  color: string;
  targetDate: string | null;
  estimateMinutes: number | null;
  taskEstimateMinutes: number;
  loggedMinutes: number;
  loggedDirectMinutes: number;
  counts: Record<string, number>;
  total: number;
  shipped: number;
}

export interface Folder {
  id: number;
  parentId: number | null;
  name: string;
  sortOrder: number;
}

export interface FileItem {
  id: number;
  folderId: number | null;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface Tree {
  folders: Folder[];
  epochs: Array<{ id: number; name: string; color: string; folderId: number | null; total: number; shipped: number }>;
  tasks: Array<{ id: number; key: string; title: string; status: string; type: string; folderId: number | null; epochId: number | null }>;
  files: FileItem[];
}

export interface TimeEntry {
  id: number;
  projectId: number;
  taskId: number | null;
  taskKey: string | null;
  taskTitle: string | null;
  epochId: number | null;
  epochName: string | null;
  target: 'task' | 'epoch';
  actor: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
  running: boolean;
  note: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  description: string;
  layer: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  link?: { kind: 'task' | 'epoch' | 'folder' | 'file'; id: number } | null;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface Diagram {
  id: number;
  name: string;
  version: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  updatedAt: string;
}

export interface User {
  id: number;
  username: string;
  /** Admins add and remove accounts and see backups. Nobody sees other people's projects. */
  isAdmin: boolean;
}
