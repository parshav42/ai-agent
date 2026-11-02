from fastapi import FastAPI,HTTPException

app = FastAPI()

text = {1:{'title':'cool'}}

@app.get('/')
def hello(ID: int):
    if ID not in text:
        raise HTTPException(status_code=404, detail="Item not found")

    
    return text.get(ID)