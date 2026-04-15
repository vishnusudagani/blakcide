
import {createRequire as ___nfyCreateRequire} from "module";
import {fileURLToPath as ___nfyFileURLToPath} from "url";
import {dirname as ___nfyPathDirname} from "path";
let __filename=___nfyFileURLToPath(import.meta.url);
let __dirname=___nfyPathDirname(___nfyFileURLToPath(import.meta.url));
let require=___nfyCreateRequire(import.meta.url);


// netlify/functions/chat-stream.mjs
var chat_stream_default = async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let messages;
  try {
    const body = await req.json();
    messages = body.messages;
    if (!messages || !Array.isArray(messages)) throw new Error("No messages");
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages,
        temperature: 0.75,
        max_tokens: 400,
        stream: true
      })
    });
    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI error:", errText);
      return new Response(JSON.stringify({ error: "AI unavailable", detail: errText }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }
    const reader = openaiRes.body.getReader();
    const decoder = new TextDecoder();
    let full = "", buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const p = t.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          full += JSON.parse(p).choices?.[0]?.delta?.content || "";
        } catch (_) {
        }
      }
    }
    return new Response(JSON.stringify({ reply: full || "I am here for you." }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("chat-stream error:", err);
    return new Response(JSON.stringify({ error: "Server error", detail: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
var config = { path: "/api/chat" };
export {
  config,
  chat_stream_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibmV0bGlmeS9mdW5jdGlvbnMvY2hhdC1zdHJlYW0ubWpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBOZXRsaWZ5IEZ1bmN0aW9ucyB2MiBcdTIwMTQgT3BlbkFJIHByb3h5IChncHQtNG8pXG5leHBvcnQgZGVmYXVsdCBhc3luYyAocmVxKSA9PiB7XG4gICAgaWYgKHJlcS5tZXRob2QgIT09ICdQT1NUJykge1xuICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCdNZXRob2QgTm90IEFsbG93ZWQnLCB7IHN0YXR1czogNDA1IH0pO1xuICAgIH1cblxuICAgIGxldCBtZXNzYWdlcztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVxLmpzb24oKTtcbiAgICAgICAgbWVzc2FnZXMgPSBib2R5Lm1lc3NhZ2VzO1xuICAgICAgICBpZiAoIW1lc3NhZ2VzIHx8ICFBcnJheS5pc0FycmF5KG1lc3NhZ2VzKSkgdGhyb3cgbmV3IEVycm9yKCdObyBtZXNzYWdlcycpO1xuICAgIH0gY2F0Y2goZSkge1xuICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIHJlcXVlc3QgYm9keScgfSksIHtcbiAgICAgICAgICAgIHN0YXR1czogNDAwLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBhcGlLZXkgPSBwcm9jZXNzLmVudi5PUEVOQUlfQVBJX0tFWTtcbiAgICBpZiAoIWFwaUtleSkge1xuICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdBUEkga2V5IG5vdCBjb25maWd1cmVkJyB9KSwge1xuICAgICAgICAgICAgc3RhdHVzOiA1MDAsIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG9wZW5haVJlcyA9IGF3YWl0IGZldGNoKCdodHRwczovL2FwaS5vcGVuYWkuY29tL3YxL2NoYXQvY29tcGxldGlvbnMnLCB7XG4gICAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke2FwaUtleX1gXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgIG1vZGVsOiAnZ3B0LTRvJyxcbiAgICAgICAgICAgICAgICBtZXNzYWdlcyxcbiAgICAgICAgICAgICAgICB0ZW1wZXJhdHVyZTogMC43NSxcbiAgICAgICAgICAgICAgICBtYXhfdG9rZW5zOiA0MDAsXG4gICAgICAgICAgICAgICAgc3RyZWFtOiB0cnVlXG4gICAgICAgICAgICB9KVxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoIW9wZW5haVJlcy5vaykge1xuICAgICAgICAgICAgY29uc3QgZXJyVGV4dCA9IGF3YWl0IG9wZW5haVJlcy50ZXh0KCk7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdPcGVuQUkgZXJyb3I6JywgZXJyVGV4dCk7XG4gICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdBSSB1bmF2YWlsYWJsZScsIGRldGFpbDogZXJyVGV4dCB9KSwge1xuICAgICAgICAgICAgICAgIHN0YXR1czogNTAyLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByZWFkZXIgID0gb3BlbmFpUmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGZ1bGwgPSAnJywgYnVmID0gJyc7XG5cbiAgICAgICAgd2hpbGUgKHRydWUpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgICBpZiAoZG9uZSkgYnJlYWs7XG4gICAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgICAgICAgICAgY29uc3QgbGluZXMgPSBidWYuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgYnVmID0gbGluZXMucG9wKCk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0ID0gbGluZS50cmltKCk7XG4gICAgICAgICAgICAgICAgaWYgKCF0LnN0YXJ0c1dpdGgoJ2RhdGE6JykpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IHAgPSB0LnNsaWNlKDUpLnRyaW0oKTtcbiAgICAgICAgICAgICAgICBpZiAocCA9PT0gJ1tET05FXScpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIHRyeSB7IGZ1bGwgKz0gSlNPTi5wYXJzZShwKS5jaG9pY2VzPy5bMF0/LmRlbHRhPy5jb250ZW50IHx8ICcnOyB9IGNhdGNoKF8pIHt9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgcmVwbHk6IGZ1bGwgfHwgJ0kgYW0gaGVyZSBmb3IgeW91LicgfSksIHtcbiAgICAgICAgICAgIHN0YXR1czogMjAwLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfVxuICAgICAgICB9KTtcblxuICAgIH0gY2F0Y2goZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ2NoYXQtc3RyZWFtIGVycm9yOicsIGVycik7XG4gICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1NlcnZlciBlcnJvcicsIGRldGFpbDogZXJyLm1lc3NhZ2UgfSksIHtcbiAgICAgICAgICAgIHN0YXR1czogNTAwLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfVxuICAgICAgICB9KTtcbiAgICB9XG59O1xuXG5leHBvcnQgY29uc3QgY29uZmlnID0geyBwYXRoOiAnL2FwaS9jaGF0JyB9O1xuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7OztBQUNBLElBQU8sc0JBQVEsT0FBTyxRQUFRO0FBQzFCLE1BQUksSUFBSSxXQUFXLFFBQVE7QUFDdkIsV0FBTyxJQUFJLFNBQVMsc0JBQXNCLEVBQUUsUUFBUSxJQUFJLENBQUM7QUFBQSxFQUM3RDtBQUVBLE1BQUk7QUFDSixNQUFJO0FBQ0EsVUFBTSxPQUFPLE1BQU0sSUFBSSxLQUFLO0FBQzVCLGVBQVcsS0FBSztBQUNoQixRQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sUUFBUSxRQUFRLEVBQUcsT0FBTSxJQUFJLE1BQU0sYUFBYTtBQUFBLEVBQzVFLFNBQVEsR0FBRztBQUNQLFdBQU8sSUFBSSxTQUFTLEtBQUssVUFBVSxFQUFFLE9BQU8sdUJBQXVCLENBQUMsR0FBRztBQUFBLE1BQ25FLFFBQVE7QUFBQSxNQUFLLFNBQVMsRUFBRSxnQkFBZ0IsbUJBQW1CO0FBQUEsSUFDL0QsQ0FBQztBQUFBLEVBQ0w7QUFFQSxRQUFNLFNBQVMsUUFBUSxJQUFJO0FBQzNCLE1BQUksQ0FBQyxRQUFRO0FBQ1QsV0FBTyxJQUFJLFNBQVMsS0FBSyxVQUFVLEVBQUUsT0FBTyx5QkFBeUIsQ0FBQyxHQUFHO0FBQUEsTUFDckUsUUFBUTtBQUFBLE1BQUssU0FBUyxFQUFFLGdCQUFnQixtQkFBbUI7QUFBQSxJQUMvRCxDQUFDO0FBQUEsRUFDTDtBQUVBLE1BQUk7QUFDQSxVQUFNLFlBQVksTUFBTSxNQUFNLDhDQUE4QztBQUFBLE1BQ3hFLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxRQUNMLGdCQUFnQjtBQUFBLFFBQ2hCLGlCQUFpQixVQUFVLE1BQU07QUFBQSxNQUNyQztBQUFBLE1BQ0EsTUFBTSxLQUFLLFVBQVU7QUFBQSxRQUNqQixPQUFPO0FBQUEsUUFDUDtBQUFBLFFBQ0EsYUFBYTtBQUFBLFFBQ2IsWUFBWTtBQUFBLFFBQ1osUUFBUTtBQUFBLE1BQ1osQ0FBQztBQUFBLElBQ0wsQ0FBQztBQUVELFFBQUksQ0FBQyxVQUFVLElBQUk7QUFDZixZQUFNLFVBQVUsTUFBTSxVQUFVLEtBQUs7QUFDckMsY0FBUSxNQUFNLGlCQUFpQixPQUFPO0FBQ3RDLGFBQU8sSUFBSSxTQUFTLEtBQUssVUFBVSxFQUFFLE9BQU8sa0JBQWtCLFFBQVEsUUFBUSxDQUFDLEdBQUc7QUFBQSxRQUM5RSxRQUFRO0FBQUEsUUFBSyxTQUFTLEVBQUUsZ0JBQWdCLG1CQUFtQjtBQUFBLE1BQy9ELENBQUM7QUFBQSxJQUNMO0FBRUEsVUFBTSxTQUFVLFVBQVUsS0FBSyxVQUFVO0FBQ3pDLFVBQU0sVUFBVSxJQUFJLFlBQVk7QUFDaEMsUUFBSSxPQUFPLElBQUksTUFBTTtBQUVyQixXQUFPLE1BQU07QUFDVCxZQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxPQUFPLEtBQUs7QUFDMUMsVUFBSSxLQUFNO0FBQ1YsYUFBTyxRQUFRLE9BQU8sT0FBTyxFQUFFLFFBQVEsS0FBSyxDQUFDO0FBQzdDLFlBQU0sUUFBUSxJQUFJLE1BQU0sSUFBSTtBQUM1QixZQUFNLE1BQU0sSUFBSTtBQUNoQixpQkFBVyxRQUFRLE9BQU87QUFDdEIsY0FBTSxJQUFJLEtBQUssS0FBSztBQUNwQixZQUFJLENBQUMsRUFBRSxXQUFXLE9BQU8sRUFBRztBQUM1QixjQUFNLElBQUksRUFBRSxNQUFNLENBQUMsRUFBRSxLQUFLO0FBQzFCLFlBQUksTUFBTSxTQUFVO0FBQ3BCLFlBQUk7QUFBRSxrQkFBUSxLQUFLLE1BQU0sQ0FBQyxFQUFFLFVBQVUsQ0FBQyxHQUFHLE9BQU8sV0FBVztBQUFBLFFBQUksU0FBUSxHQUFHO0FBQUEsUUFBQztBQUFBLE1BQ2hGO0FBQUEsSUFDSjtBQUVBLFdBQU8sSUFBSSxTQUFTLEtBQUssVUFBVSxFQUFFLE9BQU8sUUFBUSxxQkFBcUIsQ0FBQyxHQUFHO0FBQUEsTUFDekUsUUFBUTtBQUFBLE1BQUssU0FBUyxFQUFFLGdCQUFnQixtQkFBbUI7QUFBQSxJQUMvRCxDQUFDO0FBQUEsRUFFTCxTQUFRLEtBQUs7QUFDVCxZQUFRLE1BQU0sc0JBQXNCLEdBQUc7QUFDdkMsV0FBTyxJQUFJLFNBQVMsS0FBSyxVQUFVLEVBQUUsT0FBTyxnQkFBZ0IsUUFBUSxJQUFJLFFBQVEsQ0FBQyxHQUFHO0FBQUEsTUFDaEYsUUFBUTtBQUFBLE1BQUssU0FBUyxFQUFFLGdCQUFnQixtQkFBbUI7QUFBQSxJQUMvRCxDQUFDO0FBQUEsRUFDTDtBQUNKO0FBRU8sSUFBTSxTQUFTLEVBQUUsTUFBTSxZQUFZOyIsCiAgIm5hbWVzIjogW10KfQo=
