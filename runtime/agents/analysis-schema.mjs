import Ajv from 'ajv';

const text = { type: 'string', minLength: 1, maxLength: 4000 };
const strings = { type: 'array', maxItems: 30, items: text };
export const analysisSchema = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'requirements', 'missing_inputs', 'impact', 'questions'],
  properties: {
    status: { type: 'string', enum: ['completed', 'needs_human'],
      description: '현재 단계의 필수 입력이 충분하면 completed. 누락 입력이나 답변이 필요한 질문이 하나라도 있으면 needs_human.' },
    summary: text,
    requirements: { type: 'array', maxItems: 30, items: {
      type: 'object', additionalProperties: false, required: ['id', 'text', 'acceptance'],
      properties: { id: { type: 'string', pattern: '^REQ-[0-9]{3}$' }, text, acceptance: text },
    } },
    missing_inputs: { ...strings, description: '현재 단계 수행을 막는 필수 입력만. 후속 구현/장비/배포 준비 사항은 제외. completed이면 빈 배열.' },
    impact: strings,
    questions: { ...strings, description: '사람의 답이 필요한 구체 질문. completed이면 빈 배열, needs_human이면 최소 한 개.' },
  },
};
const validate = new Ajv({ allErrors: false }).compile(analysisSchema);

export function validateAnalysis(value, step) {
  let reason;
  if (!validate(value) || !['P01', 'P02'].includes(step)) reason = 'SCHEMA_MISMATCH';
  else if (new Set(value.requirements.map(item => item.id)).size !== value.requirements.length) reason = 'DUPLICATE_REQUIREMENT';
  else if (value.status === 'needs_human' && value.questions.length === 0) reason = 'QUESTION_REQUIRED';
  else if (value.status === 'completed' && (value.questions.length > 0 || value.missing_inputs.length > 0)) reason = 'UNRESOLVED_INPUT';
  else if (step === 'P02' && value.status === 'completed' && value.requirements.length === 0) reason = 'REQUIREMENTS_REQUIRED';
  if (reason) throw Object.assign(new Error('AGENT_OUTPUT_INVALID'), { reason });
  return structuredClone(value);
}
