import json

from openai import OpenAI
from tool import tool, FUNCTION_MAP



client = OpenAI(
    base_url = 'http://127.0.0.1:11434/v1',
    api_key = 'dumy'
)
messag = []

while True:
    inp = input('Parshav:')
    if inp == 'exit':
        break
    messag.append({
        'role': 'user',
        'content': inp
    })


    
    result = client.chat.completions.create(
    model = 'qwen3:1.7b',
    messages=inp,
    tools=tool
)

    msg = result.choices[0].message
    if msg.tool:
        messag.append(msg)

    for tool_call in msg.tool_calls:
        tool_name = tool_call.name
        tool_args = json.load(tool_call.arguments)
        fn = FUNCTION_MAP.get(tool_name)
        result = fn(**tool_args)

        messag.append({
            'role':'assistant',
            'tool_id':tool_call.tool_id,
            'content': result
        })
    result = client.chat.completions.create(
        model = 'qwen3:1.7b',
        messages=messag
    )

    msg = result.choices[0].message

messag.append({
    'role':'assistant',
    'content': msg.content
})


print(msg.content)