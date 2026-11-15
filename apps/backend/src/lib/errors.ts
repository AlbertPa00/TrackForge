export interface JiraErrorResponse {
  errorMessages: string[];
  errors: Record<string, string>;
}

export function jiraError(messages: string[] = [], fieldErrors: Record<string, string> = {}): JiraErrorResponse {
  return { errorMessages: messages, errors: fieldErrors };
}

export class JiraApiError extends Error {
  constructor(
    public status: number,
    public response: JiraErrorResponse
  ) {
    super(response.errorMessages[0] ?? 'API error');
  }
}
