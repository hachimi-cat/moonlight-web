use crate::api::bindings::ConfigJs;
use actix_files::Files;
use actix_web::{HttpResponse, dev::HttpServiceFactory, get, services, web::Data};
use log::warn;

use crate::app::App;

pub fn web_service() -> impl HttpServiceFactory {
    #[cfg(debug_assertions)]
    let files = Files::new("/", "dist").index_file("index.html");

    #[cfg(not(debug_assertions))]
    let files = Files::new("/", "static").index_file("index.html");

    files
}

pub fn web_config_js_service() -> impl HttpServiceFactory {
    services![config_js]
}
#[get("/config.js")]
async fn config_js(app: Data<App>) -> HttpResponse {
    let config_json = match serde_json::to_string(&ConfigJs {
        path_prefix: app.config().web_server.url_path_prefix.clone(),
    }) {
        Ok(value) => value,
        Err(err) => {
            warn!(
                "failed to create the web config.js. The Web Interface might fail to load! {err:?}"
            );

            return HttpResponse::InternalServerError().finish();
        }
    };
    // Emitted as a CLASSIC script that assigns a global, not an ES module.
    //
    // The web client used to ship as raw ES modules, so `import CONFIG from
    // "./config.js"` in config_.ts was a real HTTP request that landed on
    // this route. Since the webpack build, that import is rewritten to the
    // `window.__RUNTIME_CONFIG__` external — and nothing was assigning it, so
    // `path_prefix` silently resolved to "" and every URL the client built
    // pointed at the origin root. That breaks any deployment served under a
    // prefix (pawpado proxies each instance under /stream/i/<id>).
    //
    // `export default` would be a syntax error in a classic script, so the
    // global assignment IS the interface now; the templates load this before
    // the bundle.
    let config_js = format!("window.__RUNTIME_CONFIG__ = {config_json};");

    HttpResponse::Ok()
        .append_header(("Content-Type", "text/javascript"))
        .body(config_js)
}
