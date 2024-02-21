class SafariExtension extends ExtensionBase {

    constructor() {
        super('safari-web-extension', globalThis.location.host);

        // Convert patterns to regexps
        const patternToRegExp = (matchPattern: string) => new RegExp('^' + matchPattern
            .replace(/[\-\/\\\^\$\+\?\.\(\)\|\[\]\{\}]/g, '\\$&')
            .replace(/\*/g, '.*'));
        let contentScripts = browser.runtime.getManifest().content_scripts!
            .map(group => Object.assign({
                regexp_matches: (group.matches || []).map(patternToRegExp),
                regexp_exclude_matches: (group.exclude_matches || []).map(patternToRegExp)
            }, group));

        // Manualy inject content scripts on all tabs.
        browser.tabs.query({}, tabs =>
            tabs && tabs.forEach(tab => {
                const tabId = tab.id;
                if (tabId == null) {
                    return;
                }

                let loadedFiles: { [path: string]: boolean } = {};

                // Check each content scripts group
                contentScripts.forEach(group => {

                    // Do not load same scripts twice
                    let jsFiles = (group.js || []).filter(path => !loadedFiles[path]);
                    let cssFiles = (group.css || []).filter(path => !loadedFiles[path]);
                    const isMatched = (regexps) => regexps.some(r => r.test(tab.url));

                    if (isMatched(group.regexp_matches) && !isMatched(group.regexp_exclude_matches)) {

                        browser.scripting.executeScript({
                            target: { tabId },
                            files: jsFiles
                        });
                        jsFiles.forEach(file => loadedFiles[file] = true);

                        browser.scripting.insertCSS({
                            target: { tabId },
                            files: cssFiles
                        });
                        cssFiles.forEach(file => loadedFiles[file] = true);
                    }
                });
            }));
    }
}

new SafariExtension();
