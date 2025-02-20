/**
 *  Genesys Cloud Function for:
 *   1) Downloading a PDF, image, or audio file from a publicly accessible URL
 *      or from a Genesys Cloud stored file download URL
 *   2) Uploading that file to Google Gemini via File API (resumable upload)
 *   3) Calling generateContent with the returned file_uri(s) plus any text prompt
 *   4) Returning the Gemini result to Genesys Cloud
 *
 * The Google API key is retrieved from the function's clientContext ("googleApiKey" in clientContext).
 *
 * Required inputs from event (or event.rawRequest):
 *   - pdfDownloadUrl:    string, public URL to a PDF to be downloaded (optional)
 *   - imageDownloadUrl:  string, public URL to an image to be downloaded (optional)
 *   - audioDownloadUrl:  string, public URL to an audio file to be downloaded (optional)
 *   - model:             string, e.g. "gemini-1.5-flash" (optional, defaults to gemini-2.0-flash-exp)
 *   - system_message:    string, optional system instruction for Gemini
 *   - user_message:      string, user's text prompt for Gemini (required)
 *   - temperature:       number, optional generation temperature (defaults to 0.3)
 *   - max_tokens:        integer, optional maximum output tokens (defaults to 1024)
 *   - isJsonResponse:    boolean, optional flag to request a controlled JSON response
 *   - responseSchema:    string, optional JSON string defining the response schema for controlled generation
 *
 * Additionally, for Genesys Cloud stored files, the download URL is of the form:
 *   https://api-downloads.mypurecloud.de/api/v2/downloads/<downloadId>
 * In such cases the downloadId is extracted and the file is downloaded by calling:
 *   https://api.mypurecloud.de/api/v2/downloads/<downloadId>
 * with an OAuth bearer token obtained using gcClientId and gcClientSecret (provided in headers or clientContext).
 */

const axios = require('axios');

const inputSchema = {
  "$schema": "http://json-schema.org/draft-04/schema#",
  "type": "object",
  "required": [
    "user_message"
  ],
  "properties": {
    "pdfDownloadUrl": {
      "description": "Public URL to the PDF to be downloaded",
      "type": "string"
    },
    "imageDownloadUrl": {
      "description": "Public URL to the image to be downloaded",
      "type": "string"
    },
    "audioDownloadUrl": {
      "description": "Public URL to the audio file to be downloaded",
      "type": "string"
    },
    "model": {
      "description": "The Google Gemini model to use",
      "default": "gemini-2.0-flash-exp",
      "type": "string"
    },
    "system_message": {
      "description": "Optional system instruction for Gemini",
      "type": "string"
    },
    "user_message": {
      "description": "User's text prompt for Gemini",
      "type": "string"
    },
    "temperature": {
      "description": "Optional generation temperature",
      "type": "number",
      "default": 0.3
    },
    "max_tokens": {
      "description": "Optional maximum number of tokens to generate in response",
      "type": "integer",
      "default": 1024
    },
    "isJsonResponse": {
      "description": "Flag indicating if a controlled JSON response is desired",
      "type": "boolean"
    },
    "responseSchema": {
      "description": "A JSON string defining the response schema for controlled generation",
      "type": "string"
    }
  }
};

const outputSchema = {
  "$schema": "http://json-schema.org/draft-04/schema#",
  "type": "object",
  "required": [
    "status",
    "message"
  ],
  "properties": {
    "status": {
      "description": "HTTP status code of the function's outcome",
      "type": "number"
    },
    "message": {
      "description": "A message describing the function's outcome (e.g., 'success', 'error')",
      "type": "string"
    },
    "geminiResponse": {
      "description": "The raw JSON response from the Google Gemini API",
      "type": "object",
      "properties": {},
      "additionalProperties": true
    },
    "textOutput": {
      "description": "The text output extracted from the Gemini response",
      "type": "string"
    },
    "finishReason": {
      "description": "The reason Gemini finished generating content",
      "type": "string"
    },
    "usage": {
      "description": "Usage metadata from the Gemini API",
      "type": "object",
      "properties": {},
      "additionalProperties": true
    },
    "detail": {
      "description": "Additional error details if available",
      "type": "string"
    }
  },
  "additionalProperties": true
};

/**
 * Simple validator that:
 * 1) Checks that all required fields are present
 * 2) Checks that the type of each known property is correct (when present)
 */
function validateInput(data) {
  // Ensure required fields exist
  for (const requiredProperty of inputSchema.required) {
    if (!(requiredProperty in data)) {
      return `Missing required property: ${requiredProperty}`;
    }
  }
  // Validate types of known properties (if present)
  for (const propertyName of Object.keys(inputSchema.properties)) {
    const schemaType = inputSchema.properties[propertyName].type;
    if (propertyName in data) {
      // Check type
      if (schemaType === 'string' && typeof data[propertyName] !== 'string') {
        return `Property '${propertyName}' should be a string`;
      } else if (schemaType === 'number' && typeof data[propertyName] !== 'number') {
        return `Property '${propertyName}' should be a number`;
      } else if (schemaType === 'boolean' && typeof data[propertyName] !== 'boolean') {
        return `Property '${propertyName}' should be a boolean`;
      }
    }
  }
  return null;
}

function formatOutput(output) {
  // Copy over only known properties from outputSchema
  const formattedOutput = {};
  Object.keys(outputSchema.properties).forEach((prop) => {
    if (prop in output) {
      formattedOutput[prop] = output[prop];
    }
  });

  // Check required
  for (const requiredProperty of outputSchema.required) {
    if (!formattedOutput.hasOwnProperty(requiredProperty)) {
      console.error(`Missing required output property: ${requiredProperty}`);
      return {
        status: 500,
        message: "Internal error: missing required output property"
      };
    }
  }
  // Include any other fields the function wants to pass back
  Object.keys(output).forEach((prop) => {
    if (!(prop in formattedOutput)) {
      formattedOutput[prop] = output[prop];
    }
  });

  return formattedOutput;
}

/**
 * Helper function to guess MIME type based on URL and file category.
 */
function guessMimeType(url, fileType) {
  const lower = url.toLowerCase();
  if (fileType === 'pdf') {
    return 'application/pdf';
  } else if (fileType === 'image') {
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpeg') || lower.endsWith('.jpg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  } else if (fileType === 'audio') {
    if (lower.endsWith('.wav')) return 'audio/wav';
    if (lower.endsWith('.mp3')) return 'audio/mp3';
    if (lower.endsWith('.ogg')) return 'audio/ogg';
    return 'audio/mp3';
  }
  return '';
}

/**
 * New helper function to download file bytes.
 * Supports both direct file URLs and Genesys Cloud file download URLs.
 */
async function fetchFile(url, fileType, credentials) {
  // Check if the URL is a Genesys Cloud file download URL by matching the pattern.
  // Pattern: https://api-downloads.<domain>/api/v2/downloads/<downloadId>
  const genesysRegex = /^https:\/\/api-downloads\.([^/]+)\/api\/v2\/downloads\/(.+)$/;
  const match = url.match(genesysRegex);
  if (match) {
    const domain = match[1]; // e.g., mypurecloud.de, mypurecloud.ie, etc.
    const downloadId = match[2];
    const gcClientId = credentials?.gcClientId;
    const gcClientSecret = credentials?.gcClientSecret;
    if (!gcClientId || !gcClientSecret) {
      throw new Error("Missing gcClientId or gcClientSecret in headers or clientContext for Genesys Cloud file download.");
    }
    let tokenResp;
    // Use the login endpoint for obtaining the OAuth token.
    const tokenUrl = `https://login.${domain}/oauth/token`;
    try {
      tokenResp = await axios.post(tokenUrl, null, {
        params: { grant_type: "client_credentials" },
        headers: {
          "Authorization": "Basic " + Buffer.from(`${gcClientId}:${gcClientSecret}`).toString('base64')
        }
      });
    } catch (err) {
      throw new Error("Failed to obtain Genesys Cloud OAuth token: " + err.message);
    }
    const accessToken = tokenResp.data.access_token;
    if (!accessToken) {
      throw new Error("Failed to obtain access token from Genesys Cloud.");
    }
    const downloadUrl = `https://api.${domain}/api/v2/downloads/${downloadId}`;
    try {
      const downloadResp = await axios.get(downloadUrl, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer"
      });
      return downloadResp.data;
    } catch (err) {
      throw new Error("Error downloading file from Genesys Cloud: " + err.message);
    }
  } else {
    // Direct download from public URL
    try {
      const downloadResp = await axios.get(url, { responseType: "arraybuffer" });
      return downloadResp.data;
    } catch (err) {
      throw new Error("Error downloading file: " + err.message);
    }
  }
}

/**
 * Helper function to perform a resumable upload via the Gemini File API.
 */
async function uploadFile(fileBytes, mimeType, displayName, googleApiKey) {
  const metaResponse = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${googleApiKey}`,
    { file: { display_name: displayName } },
    {
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": fileBytes.byteLength,
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json"
      },
      validateStatus: () => true
    }
  );
  const uploadUrl = metaResponse.headers["x-goog-upload-url"];
  if (!uploadUrl) {
    throw new Error("Failed to start resumable upload: " + JSON.stringify(metaResponse.data));
  }
  const finalizeResp = await axios.post(uploadUrl, fileBytes, {
    headers: {
      "Content-Length": fileBytes.byteLength,
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    responseType: "json"
  });
  const fileUri = finalizeResp.data?.file?.uri;
  if (!fileUri) {
    throw new Error("Failed to finalize upload: " + JSON.stringify(finalizeResp.data));
  }
  return fileUri;
}

exports.handler = async (event, context, callback) => {
  console.log("## Context: " + JSON.stringify(context));
  console.log("## Event: " + JSON.stringify(event));

  try {
    // 1) Determine the input payload: prioritize rawRequest, fallback to event
    let payload;
    if (event.rawRequest) {
      try {
        payload = JSON.parse(event.rawRequest);
        console.log("Parsed rawRequest JSON successfully:", payload);
      } catch (parseErr) {
        console.error("Failed to parse rawRequest JSON:", parseErr);
        const errorResponse = formatOutput({
          status: 400,
          message: "rawRequest is not valid JSON",
          detail: parseErr.message
        });
        return callback(null, errorResponse);
      }
    } else {
      payload = event;
      console.log("Using event as payload:", payload);
    }

    // Validate input
    const inputError = validateInput(payload);
    if (inputError) {
      const errorResponse = formatOutput({
        status: 400,
        message: `Invalid input: ${inputError}`
      });
      return callback(null, errorResponse);
    }

    // Extract Genesys Cloud credentials from either event.headers or context.clientContext
    const gcCredentials = {
      gcClientId: (event.headers && event.headers.gcClientId) || (context.clientContext && context.clientContext.gcClientId),
      gcClientSecret: (event.headers && event.headers.gcClientSecret) || (context.clientContext && context.clientContext.gcClientSecret)
    };

    // Extract fields from payload
    const pdfDownloadUrl = payload.pdfDownloadUrl;
    const imageDownloadUrl = payload.imageDownloadUrl;
    const audioDownloadUrl = payload.audioDownloadUrl;
    const model = payload.model || "gemini-2.0-flash-exp";
    const systemText = payload.system_message || "";
    const userPrompt = payload.user_message || "";
    const temperature = (payload.temperature !== undefined) ? payload.temperature : 0.3;
    const maxTokens = (payload.max_tokens !== undefined) ? payload.max_tokens : 1024;

    // Retrieve Google API Key from clientContext
    const googleApiKey = context.clientContext?.googleApiKey;
    if (!googleApiKey) {
      const errorResponse = formatOutput({
        status: 400,
        message: "Missing googleApiKey in context.clientContext"
      });
      return callback(null, errorResponse);
    }

    // 2) Download and upload files for each modality
    const fileUploads = [];

    // Process PDF if provided
    if (pdfDownloadUrl) {
      let pdfBytes;
      try {
        pdfBytes = await fetchFile(pdfDownloadUrl, 'pdf', gcCredentials);
      } catch (err) {
        console.error("Error fetching PDF:", err.message);
        const errorResponse = formatOutput({
          status: 400,
          message: "Failed to download PDF",
          detail: err.message
        });
        return callback(null, errorResponse);
      }
      try {
        const mimeType = guessMimeType(pdfDownloadUrl, 'pdf');
        const fileUri = await uploadFile(pdfBytes, mimeType, "GenesysPDF", googleApiKey);
        fileUploads.push({ modality: "pdf", file_uri: fileUri, mime_type: mimeType });
      } catch (err) {
        console.error("Error uploading PDF:", err.message);
        const errorResponse = formatOutput({
          status: err.response?.status || 400,
          message: "Failed to upload PDF",
          detail: err.message
        });
        return callback(null, errorResponse);
      }
    }

    // Process Image if provided
    if (imageDownloadUrl) {
      let imageBytes;
      try {
        imageBytes = await fetchFile(imageDownloadUrl, 'image', gcCredentials);
      } catch (err) {
        console.error("Error fetching image:", err.message);
        const errorResponse = formatOutput({
          status: 400,
          message: "Failed to download image",
          detail: err.message
        });
        return callback(null, errorResponse);
      }
      try {
        const mimeType = guessMimeType(imageDownloadUrl, 'image');
        const fileUri = await uploadFile(imageBytes, mimeType, "GenesysImage", googleApiKey);
        fileUploads.push({ modality: "image", file_uri: fileUri, mime_type: mimeType });
      } catch (err) {
        console.error("Error uploading image:", err.message);
        const errorResponse = formatOutput({
          status: err.response?.status || 400,
          message: "Failed to upload image",
          detail: err.message
        });
        return callback(null, errorResponse);
      }
    }

    // Process Audio if provided
    if (audioDownloadUrl) {
      let audioBytes;
      try {
        audioBytes = await fetchFile(audioDownloadUrl, 'audio', gcCredentials);
      } catch (err) {
        console.error("Error fetching audio:", err.message);
        const errorResponse = formatOutput({
          status: 400,
          message: "Failed to download audio",
          detail: err.message
        });
        return callback(null, errorResponse);
      }
      try {
        const mimeType = guessMimeType(audioDownloadUrl, 'audio');
        const fileUri = await uploadFile(audioBytes, mimeType, "GenesysAudio", googleApiKey);
        fileUploads.push({ modality: "audio", file_uri: fileUri, mime_type: mimeType });
      } catch (err) {
        console.error("Error uploading audio:", err.message);
        const errorResponse = formatOutput({
          status: err.response?.status || 400,
          message: "Failed to upload audio",
          detail: err.message
        });
        return callback(null, errorResponse);
      }
    }

    // 3) Build the parts array for generateContent based on the file modalities
    let parts = [];
    if (fileUploads.length === 0) {
      // No file provided, use text only
      parts.push({ text: userPrompt });
    } else if (fileUploads.length === 1 && fileUploads[0].modality === 'pdf') {
      if (userPrompt) {
        parts.push({ text: userPrompt });
      }
      parts.push({
        file_data: {
          mime_type: fileUploads[0].mime_type,
          file_uri: fileUploads[0].file_uri
        }
      });
    } else {
      // For multiple files or non-PDF modalities, add file parts first then text prompt.
      for (const upload of fileUploads) {
        parts.push({
          file_data: {
            mime_type: upload.mime_type,
            file_uri: upload.file_uri
          }
        });
      }
      if (userPrompt) {
        parts.push({ text: userPrompt });
      }
    }

    // 4) Call generateContent with the file parts and prompt
    const requestBody = {
      contents: [
        {
          parts
        }
      ],
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens
      }
    };

    if (systemText) {
      requestBody.system_instruction = {
        parts: [{ text: systemText }]
      };
    }

    // Incorporate controlled generation (for structured/JSON output) parameters if requested
    if (payload.isJsonResponse && payload.responseSchema) {
      try {
        const parsedSchema = JSON.parse(payload.responseSchema);
        requestBody.generationConfig.responseMimeType = "application/json";
        requestBody.generationConfig.responseSchema = parsedSchema;
      } catch (err) {
        console.error("Invalid responseSchema JSON:", err.message);
        const errorResponse = formatOutput({
          status: 400,
          message: "Invalid responseSchema JSON",
          detail: err.message
        });
        return callback(null, errorResponse);
      }
    }

    let geminiResp;
    try {
      geminiResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleApiKey}`,
        requestBody,
        {
          headers: { "Content-Type": "application/json" },
          responseType: "json"
        }
      );
    } catch (err) {
      console.error("Error calling generateContent:", err.response?.data || err.message);
      const errorResponse = formatOutput({
        status: err.response?.status || 400,
        message: "Failed to call generateContent",
        detail: err.response?.data || err.message
      });
      return callback(null, errorResponse);
    }

    // 5) Build final output
    const data = geminiResp.data;
    let textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // If controlled JSON response is requested, trim extra spaces
    if (payload.isJsonResponse) {
      textOutput = textOutput.trim();
    }
    const usage = data?.usageMetadata || {};
    const finishReason = data?.candidates?.[0]?.finishReason || "";

    const successResponse = formatOutput({
      status: 200,
      message: "success",
      geminiResponse: data,
      textOutput,
      finishReason,
      usage
    });

    return callback(null, successResponse);

  } catch (err) {
    console.error("Unexpected error in function:", err);
    const errorResponse = formatOutput({
      status: 500,
      message: "Internal error",
      detail: err.message
    });
    return callback(null, errorResponse);
  }
};
