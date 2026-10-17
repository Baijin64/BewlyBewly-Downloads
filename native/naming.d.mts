export function safeName(value: unknown): string
export function validateTemplate(value: string): void
export function renderTemplate(template: string, task: Record<string, any>, streams?: Record<string, any>): string
export function planLocation(task: Record<string, any>, streams?: Record<string, any>): { parts: string[], basename: string }
