import { describe, expect, it } from 'vitest';
import { describeError } from '../src/util/describeError.js';

/** Та же форма, что у GitbeakerRequestError: пустое сообщение, детали в `cause`. */
function gitlabError(status: number, description: unknown, url: string): Error {
  const error = new Error('', {
    cause: { description, request: new Request(url, { method: 'GET' }), response: new Response(null, { status }) },
  });
  error.name = 'GitbeakerRequestError';
  return error;
}

describe('describeError', () => {
  it('should show status, method and path when a GitLab request fails with an empty statusText', () => {
    const error = gitlabError(404, '404 Project Not Found', 'https://gitlab.example.com/api/v4/projects/acme%2Fapp?private_token=x');

    expect(describeError(error)).toBe('GitLab 404 GET /api/v4/projects/acme%2Fapp: 404 Project Not Found');
  });

  it('should serialize a structured description when GitLab returns an object message', () => {
    const error = gitlabError(400, { base: ['invalid'] }, 'https://gitlab.example.com/api/v4/projects/1/notes');

    expect(describeError(error)).toBe('GitLab 400 GET /api/v4/projects/1/notes: {"base":["invalid"]}');
  });

  it('should redact tokens when the error is not a GitLab request error', () => {
    expect(describeError(new Error('clone https://oauth2:glpat-secret@host/x failed'))).toBe('Error: clone https://***@host/x failed');
  });
});
