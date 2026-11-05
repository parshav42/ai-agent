from datetime import datetime

def get_time():
    return datetime.now().strftime('%y-%m-%d %h:%m:%s')




tool =[
    {
        'type': 'function',
        'function':{
            'name': 'get_time',
            'description': 'this help to get current time now',
            'parameters': {
                'type': 'object',
                'properties': {},},
        },

    }
s
]



FUNCTION_MAP ={
    'get_time': get_time
}