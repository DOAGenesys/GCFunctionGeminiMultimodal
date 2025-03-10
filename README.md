# Genesys Cloud Function for Google Gemini file analysis (BYOLLM)

This Genesys Cloud Function integrates Gemini multimodal LLMs, processing files (PDF, image, or audio) either from provided URLs or directly from Genesys Cloud conversations, uploading them to Google Gemini via a resumable upload, and then calling the Gemini API to generate content based on a user prompt. The function supports controlled generation, allowing you to guarantee that the model's generated output adheres to a specific JSON schema. Thanks to this function, it's possible to analyze attachments provided during a messaging conversation. The goal is to enable nobel new use cases like the one depicted on "example use case.png":

![image](https://github.com/user-attachments/assets/fcc9decf-f127-4bfe-9d0b-24c4d50409f9)


This far exceeds classic OCR analysis:

- Much greater cost efficiency.
- genAI powered. You can prompt the LLM to do any analysis you can think of, and enforce it to return a structured output (JSON).
- Multimodal: PDF, image, audio. 

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

The function supports retrieving and processing media files directly from Genesys Cloud conversations:

- When `processLastConversationFile` is set to `true`, the function will:
  - Use the provided `conversationId` to fetch conversation messages
  - Find the most recent customer message containing media
  - Download and process that media file, automatically detecting its type (PDF, image, or audio)
  - Send the file to Gemini along with the user's prompt

- When `processLastConversationFile` is set to `false`, the function will:
  - Use the file URLs provided in `pdfDownloadUrl`, `imageDownloadUrl`, or `audioDownloadUrl`
  - Process these files as before

This feature enables seamless integration with customer-uploaded files in Genesys Cloud conversations, eliminating the need to manually extract and provide file URLs.

## Enforcing and Processing JSON Responses

The function supports controlled generation of structured JSON responses from Gemini, which is particularly useful for:

- Extracting specific data points from documents or images
- Ensuring consistent output formats for downstream processing
- Building deterministic automation workflows based on AI responses

### How to Enforce JSON Output

To enforce JSON output from the Gemini API:

1. Set `isJsonResponse: true` in your request
2. Provide a valid JSON schema in the `responseSchema` parameter
3. Optionally include a guiding `system_message` that instructs the model about the desired output format

Example configuration from the digital bot flow:
```json
{
  "isJsonResponse": true,
  "responseSchema": "{\"type\": \"OBJECT\", \"properties\": {\"powerConsumption\": {\"type\": \"NUMBER\"}}}",
  "system_message": "Your task is to return a JSON object with the exact structure defined in the response schema"
}
```

### Processing JSON Responses in Architect Flows

The "Gemini multimodal" digital bot flow demonstrates how to process JSON responses:

1. **Capture the JSON response string**: 
   - The raw text output from Gemini is stored in a flow variable (e.g., `Flow.AIResponse`)

2. **Parse the JSON string into an object**:
   ```
   Flow.AIResponseJSON = JsonParse(Flow.AIResponse)
   ```

3. **Extract specific properties** from the parsed JSON:
   ```
   Flow.powerConsumptionReading = ToString(GetJsonObjectProperty(Flow.AIResponseJSON, "powerConsumption"))
   ```

4. **Use the extracted values** in your flow:
   ```
   "Your reading is *" + Flow.powerConsumptionReading + "*. We have successfully updated our systems."
   ```

This approach allows you to reliably extract structured data from unstructured content like images, PDFs, or free-form user inputs, enabling robust automation of complex tasks.

## Credential Requirements

Make sure your Genesys Cloud function integration has at least these 3 credentials set:

- **GC_Client_Id**: Genesys Cloud OAuth client credentials ID
- **GC_Client_Secret**: Genesys Cloud OAuth client credentials secret
- **Gemini_API_Key**: API key obtained from [Google AI Studio](https://aistudio.google.com)

These credentials are essential for authenticating with both Genesys Cloud and Google Gemini services.

## Digital Bot Flow Integration

"Gemini multimodal_v9-0.i3DigitalBotFlow" is a Genesys Cloud digital bot flow that leverages this function to showcase its potential use cases. 

Use this flow in conjunction with the "power meter picture.png" sample, and you should be able to replicate the use case depicted in "example use case.png".

The flow demonstrates how to:
1. Present a menu of options to users
2. Request and capture an image upload (meter reading)
3. Call the Gemini function with the uploaded image
4. Parse the resulting JSON response
5. Extract the power consumption reading
6. Provide a confirmation message to the user

This practical example shows how the function can be used to automate the processing of utility meter readings from customer-uploaded images.

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
- Upload the function.zip in this repo.

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

### Enforcing JSON Response with Schema
To request a structured JSON response:
```json
{
  "provider": "Google",
  "model": "gemini-2.0-flash-exp",
  "processLastConversationFile": true,
  "conversationId": "12345678-abcd-1234-efgh-1234567890ab",
  "user_message": "Extract the invoice total and date from this document",
  "system_message": "Return a structured JSON with the exact format specified in the schema",
  "isJsonResponse": true,
  "responseSchema": "{\"type\": \"OBJECT\", \"properties\": {\"invoiceTotal\": {\"type\": \"NUMBER\"}, \"invoiceDate\": {\"type\": \"STRING\"}}}",
  "temperature": 0.2,
  "max_tokens": 2048
}
```
