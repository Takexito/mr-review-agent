import { buildAskPrompt } from '../../codex/prompts.js';
import { parseAnswerOutput } from '../../codex/parseReview.js';
import { postAnswer } from '../../gitlab/postAnswer.js';
import type { KindHandler } from './shared.js';

export const prepareAsk: KindHandler = async (ctx) => {
  const { data, api, linkify } = ctx;
  const prompt = buildAskPrompt({
    ...ctx.diffInput,
    projectPath: data.projectPath,
    question: data.question ?? '',
    contextHints: ctx.contextHints,
    existingThreads: ctx.existingThreads,
  });

  return {
    prompt,
    publish: async (output) => {
      await postAnswer(api, data.projectId, data.mrIid, linkify(parseAnswerOutput(output)), {
        discussionId: data.discussionId,
        noteId: data.noteId,
      });
    },
  };
};
