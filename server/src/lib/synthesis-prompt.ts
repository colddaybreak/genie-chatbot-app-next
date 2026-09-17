/**
 * Prompts for the second stage of the Genie -> LLM orchestration.
 *
 * Stage 1 runs the Genie space and produces raw evidence (generated SQL,
 * result tables, suggested follow-ups). Stage 2 hands that evidence to a plain
 * chat model which writes the final, user-facing answer.
 *
 * The system prompt can be overridden at runtime via the SYNTHESIS_SYSTEM_PROMPT
 * environment variable, so wording can be tuned without a redeploy.
 */

export const DEFAULT_SYNTHESIS_SYSTEM_PROMPT = `你是一名严谨的数据分析助手。下面会给你「用户问题」以及「Genie 从数据仓库查到的原始结果」（可能包含生成的 SQL 与结果表格）。

请基于这些原始结果，用简洁、准确的中文直接回答用户的问题：
- 先给出结论，再按需补充关键细节，不要复述 SQL。
- 所有数字必须与查询结果一致，不要编造或估算。
- 如果结果为空、或不足以回答问题，请明确说明，不要臆测。
- 适当使用列表或小标题让答案更易读。`;

/**
 * Returns the synthesis system prompt, preferring the SYNTHESIS_SYSTEM_PROMPT
 * environment override when it is set to a non-empty value.
 */
export function getSynthesisSystemPrompt(): string {
  const override = process.env.SYNTHESIS_SYSTEM_PROMPT;
  return override && override.trim().length > 0
    ? override
    : DEFAULT_SYNTHESIS_SYSTEM_PROMPT;
}

/**
 * Builds the user-facing prompt for the synthesis stage from the original
 * question and the raw Genie evidence.
 */
export function buildSynthesisPrompt(params: {
  question: string;
  evidence: string;
}): string {
  const { question, evidence } = params;
  const trimmedQuestion = question.trim();
  return [
    '## 用户问题',
    trimmedQuestion.length > 0 ? trimmedQuestion : '(未提供)',
    '',
    '## Genie 查询结果',
    evidence,
  ].join('\n');
}