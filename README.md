# Genesys Cloud Function for Google Gemini Controlled Generation

This Genesys Cloud Function integrates Gemini multimodal LLMs, processing files (PDF, image, or audio) either from provided URLs or directly from Genesys Cloud conversations, uploading them to Google Gemini via a resumable upload, and then calling the Gemini API to generate content based on a user prompt. The function supports controlled generation—allowing you to guarantee that the model's generated output adheres to a specific JSON schema—and trims any extra whitespace from JSON responses.

## Overview

The function performs the following steps:

1. **Input Processing:**  
   - Parses the incoming payload (either from `rawRequest` or directly from the event).
   - Validates required fields and types.
   - Extracts Genesys Cloud credentials from request headers or the client context.

2. **File Handling:**  
   - Either processes a specific file from URLs provided in the request, OR
   - Retrieves and processes the most recent customer media file from a Genesys Cloud conversation.
   - Downloads a file from a public URL or a Genesys Cloud stored file URL (using OAuth if necessary).
   - Uploads the file to Google Gemini using a resumable upload.

3. **Content Generation:**  
   - Builds a parts array based on the uploaded files and the text prompt.
   - Constructs a request for the Gemini API.  
   - If a controlled JSON response is requested (using `isJsonResponse` and a valid `responseSchema`), the generation configuration is updated to include `responseMimeType` as `"application/json"` and the parsed JSON schema.
   - Calls the Gemini API using the provided model.

4. **Response Handling:**  
   - Extracts the generated text (or JSON) from the Gemini API response.
   - If a controlled JSON response is requested, trims extra whitespace from the response.
   - Returns a structured response containing the status, message, raw Gemini API response, extracted text output, finish reason, and usage metadata.

## Conversation File Processing

The function now supports retrieving and processing media files directly from Genesys Cloud conversations:

- When `processLastConversationFile` is set to `true`, the function will:
  - Use the provided `conversationId` to fetch conversation messages
  - Find the most recent customer message containing media
  - Download and process that media file, automatically detecting its type (PDF, image, or audio)
  - Send the file to Gemini along with the user's prompt

- When `processLastConversationFile` is set to `false`, the function will:
  - Use the file URLs provided in `pdfDownloadUrl`, `imageDownloadUrl`, or `audioDownloadUrl`
  - Process these files as before

This feature enables seamless integration with customer-uploaded files in Genesys Cloud conversations, eliminating the need to manually extract and provide file URLs.

## Genesys Cloud Function Properties

### Request Body Template
```velocity
{
  "provider": "${input.provider}",
  "model": "${input.model}",
  "processLastConversationFile": ${input.processLastConversationFile},
  "user_message": "$esc.jsonEncode(${input.user_message})"#if("$!{input.pdfDownloadUrl}" != "") , "pdfDownloadUrl": "${input.pdfDownloadUrl}"#end#if("$!{input.imageDownloadUrl}" != "") , "imageDownloadUrl": "${input.imageDownloadUrl}"#end#if("$!{input.audioDownloadUrl}" != "") , "audioDownloadUrl": "${input.audioDownloadUrl}"#end#if("$!{input.conversationId}" != "") , "conversationId": "${input.conversationId}"#end#if("$!{input.temperature}" != "") , "temperature": ${input.temperature}#end#if("$!{input.max_tokens}" != "") , "max_tokens": ${input.max_tokens}#end#if("$!{input.system_message}" != "") , "system_message": "$esc.jsonEncode(${input.system_message})"#end#if("$!{input.isJsonResponse}" != "") , "isJsonResponse": ${input.isJsonResponse}#end#if("$!{input.responseSchema}" != "") , "responseSchema": "$esc.jsonEncode(${input.responseSchema})"#end
}
```

### HTTP Method
- **POST**

### Input Contract
```json
{
  "title": "Input",
  "type": "object",
  "required": [
    "provider",
    "model",
    "user_message",
    "processLastConversationFile"
  ],
  "additionalProperties": false,
  "properties": {
    "provider": {
      "type": "string",
      "enum": [
        "Google"
      ],
      "description": "AI provider to use for processing",
      "default": "Google"
    },
    "pdfDownloadUrl": {
      "type": "string",
      "format": "uri",
      "description": "Publicly accessible URL of the PDF document. Example: https://www.crwwd.com/wp-content/uploads/bsk-pdf-manager/2019/09/Sample_Utility_Bill.pdf"
    },
    "imageDownloadUrl": {
      "type": "string",
      "format": "uri",
      "description": "Publicly accessible URL of the image file. Example: https://cdn.pixabay.com/photo/2024/05/26/10/15/bird-8788491_1280.jpg"
    },
    "audioDownloadUrl": {
      "type": "string",
      "format": "uri",
      "description": "Publicly accessible URL of the audio file. Example: https://www.ashleecadell.com/xyzstorelibrary/01-01-%20Die%20Happy.mp3"
    },
    "model": {
      "type": "string",
      "description": "Model identifier (e.g., gemini-2.0-flash-exp)",
      "enum": [
        "gemini-2.0-flash-exp",
        "gemini-2.0-pro-exp-02-05"
      ],
      "default": "gemini-2.0-flash-exp"
    },
    "max_tokens": {
      "type": "integer",
      "minimum": 4,
      "maximum": 8192,
      "description": "Maximum number of tokens to generate in response",
      "default": 4096
    },
    "temperature": {
      "type": "number",
      "default": 0.2
    },
    "user_message": {
      "type": "string",
      "description": "User's question/instruction for the document",
      "default": "Summarize the content of the document"
    },
    "system_message": {
      "type": "string",
      "description": "System prompt guiding model behavior. If isJsonResponse=true, it is recommended to also add here a description of the properties in the response schema."
    },
    "isJsonResponse": {
      "type": "boolean",
      "description": "Flag indicating if a controlled JSON response is desired",
      "default": false
    },
    "responseSchema": {
      "type": "string",
      "description": "A JSON string defining the response schema for controlled generation. Mandatory if isJsonResponse=true. Example valid schema: {\"type\": \"OBJECT\", \"properties\": {\"birdColor\": {\"type\": \"STRING\"}}}"
    },
    "conversationId": {
      "type": "string",
      "description": "Conversation ID to fetch the last customer media file. Mandatory if processLastConversationFile is true."
    },
    "processLastConversationFile": {
      "type": "boolean",
      "description": "Flag indicating if the last conversation file should be processed. If false, the file provided in pdfDownloadUrl, imageDownloadUrl, or audioDownloadUrl will be used."
    }
  }
}
```

### Output Contract
```json
{
  "title": "Output",
  "type": "object",
  "required": [
    "status",
    "message"
  ],
  "additionalProperties": true,
  "properties": {
    "status": {
      "type": "number",
      "description": "HTTP status code of the function's outcome"
    },
    "message": {
      "type": "string",
      "description": "A message describing the function's outcome"
    },
    "geminiResponse": {
      "type": "object",
      "description": "The raw JSON response from the Google Gemini API",
      "additionalProperties": true,
      "properties": {}
    },
    "textOutput": {
      "type": "string",
      "description": "The text output extracted from the Gemini response"
    },
    "finishReason": {
      "type": "string",
      "description": "The reason Gemini finished generating content"
    },
    "usage": {
      "type": "object",
      "description": "Usage metadata from the Gemini API",
      "additionalProperties": true,
      "properties": {}
    },
    "detail": {
      "type": "string",
      "description": "Additional error details if available"
    }
  }
}
```

### Request Headers
```
gcClientId=${credentials.GC_Client_Id}
gcClientSecret=${credentials.GC_Client_Secret}
googleApiKey=${credentials.Gemini_API_Key}
```

### Response Template
```json
{
  "translationMap": {},
  "translationMapDefaults": {},
  "successTemplate": "${rawResult}"
}
```

### Function Configuration
- **Handler:** `src/index.handler`
- **HTTP Method:** POST
- **Timeout:** 15 seconds
- **Runtime:** `nodejs22.x`

## Usage Examples

### Processing a File from a Conversation
To process the most recent customer media file from a conversation:
```json
{
  "provider": "Google",
  "model": "gemini-2.0-flash-exp",
  "processLastConversationFile": true,
  "conversationId": "12345678-abcd-1234-efgh-1234567890ab",
  "user_message": "What is this document about?",
  "temperature": 0.3,
  "max_tokens": 2048
}
```

### Processing a File from URL
To process a file from a provided URL:
```json
{
  "provider": "Google",
  "model": "gemini-2.0-flash-exp",
  "processLastConversationFile": false,
  "pdfDownloadUrl": "https://example.com/sample.pdf",
  "user_message": "Summarize this document",
  "temperature": 0.3,
  "max_tokens": 2048
}
```
