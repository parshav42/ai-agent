import json

from openai import OpenAI
from tool import tool, FUNCTION_MAP



client = OpenAI(
    base_url = 'http://127.0.0.1:11434/v1',
    api_key = 'dumy'
)
messages = []

while True:
    inp = input('Parshav:')
    if inp == 'exit':
        break
    messages.append({
        'role': 'user',
        'content': inp
    })

    while True:
        result = client.chat.completions.create(
            model='qwen3:1.7b',
            messages=messages,
            tools=tool
            
        )
        msg = result.choices[0].message
        messages.append(msg.model_dump(exclude_none=True))

        if not msg.tool_calls:
            break

        for tool_call in msg.tool_calls:
            tool_name = tool_call.function.name
            fn = FUNCTION_MAP.get(tool_name)
            if fn is None:
                raise ValueError(f'Unknown tool: {tool_name}')

            tool_args = json.loads(tool_call.function.arguments)
            tool_result = fn(**tool_args)
            messages.append({
                'role': 'tool',
                'tool_call_id': tool_call.id,
                'content': str(tool_result)
            })

    print('robo:', msg.content, flush=True)