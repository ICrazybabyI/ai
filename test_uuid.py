import requests
import uuid
import json

# Generate a valid UUID
conversation_id = str(uuid.uuid4())

# Test Dify API with valid UUID
url = "http://192.168.31.245:8888/v1/chat-messages"
headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer app-R751gOZN71oavN0EOmtJ52bl"
}

data = {
    "inputs": {},
    "query": "你好",
    "response_mode": "streaming",
    "conversation_id": conversation_id,
    "user": "local-user"
}

print(f"Testing Dify API with conversation_id: {conversation_id}")
print(f"URL: {url}")
print(f"Headers: {headers}")
print(f"Data: {data}")

try:
    response = requests.post(url, headers=headers, json=data, stream=True)
    print(f"Response status: {response.status_code}")
    print(f"Response headers: {dict(response.headers)}")
    
    # Read streaming response
    print("Streaming response:")
    for chunk in response.iter_content(chunk_size=1024):
        if chunk:
            print(chunk.decode('utf-8'), end='')
except Exception as e:
    print(f"Error: {e}")
