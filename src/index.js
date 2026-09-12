export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Trang kiểm tra Worker
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "TM-LT Stremio",
          status: "ok",
          version: "0.1.0",
          database: "connected"
        }, null, 2),
        {
          headers: {
            "content-type": "application/json; charset=UTF-8"
          }
        }
      );
    }

    // Kiểm tra kết nối D1
    if (url.pathname === "/health") {
      try {
        const result = await env.tm_lt_db
          .prepare("SELECT COUNT(*) AS count FROM movies")
          .first();

        return new Response(
          JSON.stringify({
            status: "ok",
            database: "connected",
            movies: result?.count ?? 0
          }, null, 2),
          {
            headers: {
              "content-type": "application/json; charset=UTF-8"
            }
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            status: "error",
            database: "connection_failed",
            message: error.message
          }, null, 2),
          {
            status: 500,
            headers: {
              "content-type": "application/json; charset=UTF-8"
            }
          }
        );
      }
    }

    return new Response("TM-LT: Not Found", {
      status: 404
    });
  }
};