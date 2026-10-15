export type Owner = 'spec-gen' | 'tc' | 'code-dev' | 'arch-runner' | 'sqe' | 'report' | 'human' | 'system';
export interface WorkflowNode { id: string; phase: number; label: string; owner: Owner; input: string; output: string; pass_criterion: string; skip_policy: string; source: string; }
export interface WorkflowEdge { id: string; from: string; to: string; kind: 'pass' | 'business_fail' | 'special'; outcome?: string; }
export interface WorkflowOutcome { from: string; event: string; target: string; isTransition: boolean; }
export interface WorkflowGraph { nodes: readonly WorkflowNode[]; edges: readonly WorkflowEdge[]; phases: readonly { id: number; label: string; nodes: readonly WorkflowNode[] }[]; outcomes: readonly WorkflowOutcome[]; }
export function buildWorkflowGraph(workflow: unknown): WorkflowGraph;
export function filterWorkflowNodes(graph: WorkflowGraph, filters?: { query?: string; owner?: string }): WorkflowNode[];
export function safeText(value: unknown, limit?: number): string;
export const ownerLabels: Record<Owner, string>;
export function requirementsForNode(node: WorkflowNode): string[];
