import { Color, Icon, getPreferenceValues } from "@raycast/api";

export interface AwxPreferences {
  awxUrl: string;
  awxToken: string;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface JobTemplate {
  id: number;
  name: string;
  description: string;
  job_type: string;
  playbook: string;
  ask_variables_on_launch?: boolean;
  last_job_run?: string | null;
  summary_fields?: {
    inventory?: { name: string };
    project?: { name: string };
    last_job?: { id: number; status: string; finished: string | null };
  };
}

export interface WorkflowJobTemplate {
  id: number;
  name: string;
  description: string;
  ask_variables_on_launch?: boolean;
  summary_fields?: {
    organization?: { name: string };
    last_job?: { id: number; status: string; finished: string | null };
  };
}

/** A node in a workflow's graph — usually wraps a job template ("stage"). */
export interface WorkflowNode {
  id: number;
  identifier?: string;
  success_nodes: number[];
  failure_nodes: number[];
  always_nodes: number[];
  unified_job_template: number | null;
  summary_fields?: {
    unified_job_template?: {
      id: number;
      name: string;
      description?: string;
      unified_job_type?: string;
    };
  };
}

export interface SurveyQuestion {
  question_name: string;
  question_description?: string;
  variable: string;
  /** text | textarea | password | integer | float | multiplechoice | multiselect | json */
  type: string;
  required: boolean;
  default?: string | number | string[];
  /** Newline-delimited string or an array, depending on AWX version. */
  choices?: string | string[];
  min?: number | null;
  max?: number | null;
}

export interface SurveySpec {
  name?: string;
  description?: string;
  spec?: SurveyQuestion[];
}

/** A row from /unified_jobs/ — covers jobs, project/inventory updates, workflows, etc. */
export interface UnifiedJob {
  id: number;
  type: string;
  name: string;
  status: string;
  started: string | null;
  finished: string | null;
  elapsed: number;
  summary_fields?: {
    job_template?: { id: number; name: string };
    unified_job_template?: { id: number; name: string };
  };
}

export interface LaunchResponse {
  id: number;
  job: number;
  ignored_fields?: Record<string, unknown>;
}

export const RUNNING_STATUSES = ["pending", "waiting", "running"] as const;

export function getPreferences(): AwxPreferences {
  return getPreferenceValues<AwxPreferences>();
}

/** Base API URL with a normalized (no trailing slash) host. */
export function apiBase(): string {
  const { awxUrl } = getPreferences();
  return `${awxUrl.trim().replace(/\/+$/, "")}/api/v2`;
}

export function authHeaders(): Record<string, string> {
  const { awxToken } = getPreferences();
  return {
    Authorization: `Bearer ${awxToken.trim()}`,
    "Content-Type": "application/json",
  };
}

/** Web URL for a template's detail page in the AWX UI. */
export function templateWebUrl(id: number): string {
  const { awxUrl } = getPreferences();
  return `${awxUrl.trim().replace(/\/+$/, "")}/#/templates/job_template/${id}`;
}

/** API URL for a template's survey specification. */
export function surveySpecUrl(kind: "job_templates" | "workflow_job_templates", id: number): string {
  return `${apiBase()}/${kind}/${id}/survey_spec/`;
}

/** Web URL for a workflow template's detail page in the AWX UI. */
export function workflowTemplateWebUrl(id: number): string {
  const { awxUrl } = getPreferences();
  return `${awxUrl.trim().replace(/\/+$/, "")}/#/templates/workflow_job_template/${id}`;
}

/** Web URL for a running workflow job's output page in the AWX UI. */
export function workflowJobWebUrl(id: number): string {
  const { awxUrl } = getPreferences();
  return `${awxUrl.trim().replace(/\/+$/, "")}/#/jobs/workflow/${id}/output`;
}

/** Web URL for a job's output page in the AWX UI. */
export function jobWebUrl(job: UnifiedJob | number): string {
  const { awxUrl } = getPreferences();
  const base = awxUrl.trim().replace(/\/+$/, "");
  if (typeof job === "number") return `${base}/#/jobs/playbook/${job}/output`;
  const kind = job.type === "project_update" ? "project" : job.type === "inventory_update" ? "inventory" : "playbook";
  return `${base}/#/jobs/${kind}/${job.id}/output`;
}

export async function launchTemplate(id: number, extraVars?: string): Promise<LaunchResponse> {
  const body: Record<string, unknown> = {};
  if (extraVars && extraVars.trim()) {
    body.extra_vars = extraVars.trim();
  }
  const res = await fetch(`${apiBase()}/job_templates/${id}/launch/`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await describeError(res));
  }
  return (await res.json()) as LaunchResponse;
}

/** Launch an entire workflow (runs all of its stages in graph order). */
export async function launchWorkflow(id: number, extraVars?: string): Promise<LaunchResponse> {
  const body: Record<string, unknown> = {};
  if (extraVars && extraVars.trim()) {
    body.extra_vars = extraVars.trim();
  }
  const res = await fetch(`${apiBase()}/workflow_job_templates/${id}/launch/`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await describeError(res));
  }
  return (await res.json()) as LaunchResponse;
}

/** Order a workflow's nodes topologically (roots first) so stages read in run order. */
export function orderWorkflowNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childIds = new Set<number>();
  for (const n of nodes) {
    for (const c of [...n.success_nodes, ...n.failure_nodes, ...n.always_nodes]) {
      childIds.add(c);
    }
  }
  const ordered: WorkflowNode[] = [];
  const seen = new Set<number>();
  const queue = nodes.filter((n) => !childIds.has(n.id));
  while (queue.length) {
    const n = queue.shift();
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    ordered.push(n);
    for (const c of [...n.success_nodes, ...n.failure_nodes, ...n.always_nodes]) {
      const child = byId.get(c);
      if (child && !seen.has(child.id)) queue.push(child);
    }
  }
  // Append anything unreachable (cycles / orphans) so nothing is dropped.
  for (const n of nodes) {
    if (!seen.has(n.id)) ordered.push(n);
  }
  return ordered;
}

/** Cancel a running unified job, resolving the correct sub-resource for its type. */
export async function cancelJob(job: UnifiedJob): Promise<void> {
  const resource =
    job.type === "project_update"
      ? "project_updates"
      : job.type === "inventory_update"
        ? "inventory_updates"
        : job.type === "workflow_job"
          ? "workflow_jobs"
          : job.type === "system_job"
            ? "system_jobs"
            : "jobs";
  const res = await fetch(`${apiBase()}/${resource}/${job.id}/cancel/`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await describeError(res));
  }
}

async function describeError(res: Response): Promise<string> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { detail?: string; [k: string]: unknown };
      detail = json.detail ?? text;
    } catch {
      detail = text;
    }
  } catch {
    // ignore body read failures
  }
  const prefix = `AWX request failed (${res.status} ${res.statusText})`;
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function statusColor(status?: string): Color {
  switch (status) {
    case "successful":
      return Color.Green;
    case "failed":
    case "error":
    case "canceled":
      return Color.Red;
    case "running":
      return Color.Blue;
    case "pending":
    case "waiting":
      return Color.Yellow;
    default:
      return Color.SecondaryText;
  }
}

export function statusIcon(status?: string): Icon {
  switch (status) {
    case "successful":
      return Icon.CheckCircle;
    case "failed":
    case "error":
      return Icon.XMarkCircle;
    case "canceled":
      return Icon.MinusCircle;
    case "running":
      return Icon.CircleProgress;
    case "pending":
    case "waiting":
      return Icon.Clock;
    default:
      return Icon.Circle;
  }
}

export function formatElapsed(seconds: number): string {
  if (!seconds) return "0s";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
