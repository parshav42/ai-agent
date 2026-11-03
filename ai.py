from openai import OpenAI


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
    messages=inp
)
    messag.append({
        'role': 'assistant',
        'content': result.choices[0].message.content
    })


print(result.choices[0].message.content)