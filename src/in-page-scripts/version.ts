(function () {

    if (typeof document == undefined) {
        return;
    }

    const head = document.querySelector('head');

    const sendBackgroundMessage = (message: ITabMessage) => {

        chrome.runtime.sendMessage(message, () => {
            const error = chrome.runtime.lastError;

            // Background page is not loaded yet
            if (error) {
                console.log(`${message.action}: ${JSON.stringify(error, null, '  ')}`)
            }
        });
    }

    const getMeta = (metaName: string) => {
        return head?.querySelector(`meta[name="${metaName}"]`) as HTMLMetaElement;
    }

    const addMeta = (metaName: string, metaValue: string) => {

        if (!head) {
            return;
        }

        let meta = getMeta(metaName);
        if (!meta) {
            meta = document.createElement('meta');
            meta.name = metaName;
            meta.content = metaValue;
            head.appendChild(meta);
        } else if (meta.content != metaValue) {
            meta.content = metaValue;
        }
    }

    let appMeta = getMeta('application');
    if (appMeta?.content != 'TMetric') {
        return;
    }

    const extensionInfo = { // object is updated from gulp build
        version: '4.9.2'
    };

    addMeta('tmetric-extension-version', extensionInfo.version);

    chrome.runtime.onMessage.addListener((message: ITabMessage) => {
        switch (message.action) {
            case 'setConstants':
                addMeta('tmetric-extension-id', (message.data as Models.Constants).extensionUUID);
                break;
        }
    });

    sendBackgroundMessage({ action: 'getConstants' });

    // TODO: manifest v3
    // setInterval(() => sendBackgroundMessage({ action: 'getConstants' }), 25000);
})();