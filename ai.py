from openai import OpenAI


client = OpenAI(
    base_url = 'http://127.0.0.1:11434/v1',
    api_key = 'dumy'
)

while True:
    inp = input('Parshav:')
    if inp == 'exit':
        break
    
    result = client.chat.completions.create(
    model = 'qwen3:1.7b',
    messages=[
        {
            'role': 'user',
            'content':inp
        }
    ]

)


print(result.)