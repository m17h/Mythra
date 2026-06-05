import type { ChatCompletionTool } from 'openai/resources/chat/completions/completions';

type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export function defineFunctionTool(
  name: string,
  description: string,
  parameters: JsonSchemaObject
): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters
    }
  };
}

