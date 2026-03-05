async function main() {
  console.log("Starting native fetch...");
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer AIza-FAKE-KEY"
      },
      body: JSON.stringify({
        model: "gemini-3.1-flash-lite",
        messages: [{role: "user", content: "Hi"}]
      })
    });
    console.log("Status:", res.status);
    console.log("Body:", await res.text());
  } catch (err) {
    console.error("Error:", err);
  }
}
main();
