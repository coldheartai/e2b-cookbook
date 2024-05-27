import fs from 'node:fs'
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3'
import { fileURLToPath } from 'url'
import { FoundationModels } from "/Users/terezatizkova/Developer/e2b-cookbook/examples/amazon-bedrock-code-interpreter/foundation_models.js"
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime'
import { CodeInterpreter, Result } from '@e2b/code-interpreter'
import { ProcessMessage } from '@e2b/code-interpreter'
import * as dotenv from 'dotenv'
import { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/beta/tools/messages.mjs'


// Claude example with Bedrock: https://github.com/awsdocs/aws-doc-sdk-examples/blob/main/javascriptv3/example_code/bedrock-runtime/models/anthropic_claude/claude_3.js
// Amazon Bedrock Model access: https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html#model-access-permissions

dotenv.config()

// const MODEL_NAME = 'claude-3-opus-20240229'
// const SYSTEM_PROMPT = `
// ## your job & context
// you are a python data scientist. you are given tasks to complete and you run python code to solve them.
// - the python code runs in jupyter notebook.
// - every time you call \`execute_python\` tool, the python code is executed in a separate cell. it's okay to multiple calls to \`execute_python\`.
// - display visualizations using matplotlib or any other visualization library directly in the notebook. don't worry about saving the visualizations to a file.
// - you have access to the internet and can make api requests.
// - you also have access to the filesystem and can read/write files.
// - you can install any pip package (if it exists) if you need to but the usual packages for data analysis are already preinstalled.
// - you can run any python code you want, everything is running in a secure sandbox environment.

// ## style guide
// tool response values that have text inside "[]"  mean that a visual element got rendered in the notebook. for example:
// - "[chart]" means that a chart was generated in the notebook.
// `

    const SYSTEM_PROMPT = `
## your job & context
you are a python data scientist. you are given tasks to complete and you run python code to solve them.
- the python code runs in jupyter notebook.
- every time you call \`execute_python\` tool, the python code is executed in a separate cell. it's okay to multiple calls to \`execute_python\`.
- display visualizations using matplotlib or any other visualization library directly in the notebook. don't worry about saving the visualizations to a file.
- you have access to the internet and can make api requests.
- you also have access to the filesystem and can read/write files.
- you can install any pip package (if it exists) if you need to but the usual packages for data analysis are already preinstalled.
- you can run any python code you want, everything is running in a secure sandbox environment.

## style guide
tool response values that have text inside "[]"  mean that a visual element got rendered in the notebook. for example:
- "[chart]" means that a chart was generated in the notebook.
`


// Definine tools (TBD: Here or after the model instance is created?)
const tools: Array<Tool> = [
    {
        name: 'execute_python',
        description: 'Execute python code in a Jupyter notebook cell and returns any result, stdout, stderr, display_data, and error.',
        input_schema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'The python code to execute in a single cell.'
                }
            },
            required: ['code']
        }
    }
]

// Define code interpreter function (TBD: Here or after the model instance is created?)
async function codeInterpret(codeInterpreter: CodeInterpreter, code: string): Promise<Result[]> {
    console.log('Running code interpreter...')

    const exec = await codeInterpreter.notebook.execCell(code, {
        onStderr: (msg: ProcessMessage) => console.log('[Code Interpreter stderr]', msg),
        onStdout: (stdout: ProcessMessage) => console.log('[Code Interpreter stdout]', stdout),
        // You can also stream additional results like charts, images, etc.
        // onResult: ...
    })

    if (exec.error) {
        console.log('[Code Interpreter ERROR]', exec.error)
        throw new Error(exec.error.value)
    }
    return exec.results
}


export const invokeModel = async (
    prompt="Calculate value of pi using monte carlo method. Use 1000 iterations. Visualize all point of all iterations on a single plot, a point inside the unit circle should be orange, other points should be grey.",
    modelId = "anthropic.claude-3-haiku-20240307-v1:0",
  ) => {


    // Create a new Bedrock Runtime client instance.
    const client = new BedrockRuntimeClient({ region: "us-east-1" });


    // Prepare the payload for the model.
    const payload = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1000,
        messages: [
        {
            role: "user",
            content: [{ type: "text", text: prompt }],
        },
        ],
    };

    // Invoke Claude with the payload and wait for the response.
    const command = new InvokeModelCommand({
        contentType: "application/json",
        body: JSON.stringify(payload),
        modelId,
    });
    const apiResponse = await client.send(command);


    async function processToolCall(codeInterpreter: CodeInterpreter, toolName: string, toolInput: any): Promise<Result[]> {
        if (toolName === 'execute_python') {
            return await codeInterpret(codeInterpreter, toolInput['code'])
        }
        return []
    }

    async function chatWithClaude(codeInterpreter: CodeInterpreter, userMessage: string): Promise<Result[]> {
        console.log(`\n${'='.repeat(50)}\nUser Message: ${userMessage}\n${'='.repeat(50)}`)

        console.log('Waiting for Claude to respond...')
        const message = await client.beta.tools.messages.create({
            model: modelId,
            system: `
            ## your job & context
            you are a python data scientist. you are given tasks to complete and you run python code to solve them.
            - the python code runs in jupyter notebook.
            - every time you call \`execute_python\` tool, the python code is executed in a separate cell. it's okay to multiple calls to \`execute_python\`.
            - display visualizations using matplotlib or any other visualization library directly in the notebook. don't worry about saving the visualizations to a file.
            - you have access to the internet and can make api requests.
            - you also have access to the filesystem and can read/write files.
            - you can install any pip package (if it exists) if you need to but the usual packages for data analysis are already preinstalled.
            - you can run any python code you want, everything is running in a secure sandbox environment.
            
            ## style guide
            tool response values that have text inside "[]"  mean that a visual element got rendered in the notebook. for example:
            - "[chart]" means that a chart was generated in the notebook.
            `,
            max_tokens: 4096,
            messages: [{ role: 'user', content: userMessage }],
            tools: tools,
        })

        console.log(`\nInitial Response:\nStop Reason: ${message.stop_reason}`)

        if (message.stop_reason === 'tool_use') {
            const toolUse = message.content.find(block => block.type === 'tool_use') as ToolUseBlock
            if (!toolUse){
                console.error('Tool use block not found in message content.')
                return []
            }

            const toolName = toolUse.name
            const toolInput = toolUse.input

            console.log(`\nTool Used: ${toolName}\nTool Input: ${JSON.stringify(toolInput)}`)

            const codeInterpreterResults = await processToolCall(codeInterpreter, toolName, toolInput)
            console.log(`Tool Result: ${codeInterpreterResults}`)
            return codeInterpreterResults
        }
        throw new Error('Tool use block not found in message content.')
    }

  async function run() {
      const codeInterpreter = await CodeInterpreter.create()

      try {
          const codeInterpreterResults = await chatWithClaude(
              codeInterpreter,
              'Calculate value of pi using monte carlo method. Use 1000 iterations. Visualize all point of all iterations on a single plot, a point inside the unit circle should be orange, other points should be grey.'
          )
          const result = codeInterpreterResults[0]
          console.log('Result:', result)
          if (result.png) {
              fs.writeFileSync('image.png', Buffer.from(result.png, 'base64'))
          }
      } catch (error) {
          console.error('An error occurred:', error)
      } finally {
          await codeInterpreter.close()
      }
  } 

  run()

} // This is closing body of InvokeModel function


// Add action group (TBD correct order)

{
    "openapi": "3.0.0",
    "paths": {
        "/path": {
            "method": {
                "description": "string",
                "operationId": "string",
                "parameters": [ ... ],
                "requestBody": { ... },
                "responses": { ... }
           }
       }
    }
}


const tools: Array<Tool> = [
    {
        name: 'execute_python',
        description: 'Execute python code in a Jupyter notebook cell and returns any result, stdout, stderr, display_data, and error.',
        input_schema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'The python code to execute in a single cell.'
                }
            },
            required: ['code']
        }
    }
]