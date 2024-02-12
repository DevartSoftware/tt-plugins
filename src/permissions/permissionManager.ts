declare var browser: unknown;

class PermissionManager {

    browser!: typeof chrome;

    constructor() {
        this.browser = typeof browser !== 'undefined' ? browser as any : chrome;
    }

    private request(origins: string[]) {
        return this.browser.permissions.request({ origins });
    }

    private remove(origins: string[]) {
        return this.browser.permissions.remove({ origins })
    }

    requestPermissions(serviceTypes: ServiceTypesMap) {

        const { originsAdded } = WebToolManager.addServiceTypes(serviceTypes);

        return this.request(Object.keys(originsAdded));
    }

    removePermissions(serviceTypes: ServiceTypesMap) {

        const { originsRemoved } = WebToolManager.removeServiceTypes(serviceTypes);

        return this.remove(Object.keys(originsRemoved));
    }

    updatePermissions(serviceTypesAdded: ServiceTypesMap, serviceTypesRemoved: ServiceTypesMap) {

        const { originsAdded, originsRemoved } = WebToolManager.updateServiceTypes(serviceTypesAdded, serviceTypesRemoved);

        return Promise.all([
            this.request(Object.keys(originsAdded)),
            this.remove(Object.keys(originsRemoved)),
        ]);
    }

    cleanupPermissions() {

        let callback: (result: boolean) => void;

        this.browser.permissions.getAll(allPermissions => {

            const manifest = this.browser.runtime.getManifest();
            const requiredPermissions = (manifest.permissions as string[])
                .concat(
                    ...(manifest.content_scripts || []).map(_ => _.matches as string[])
                );
            const origins = (allPermissions.origins || []).filter(o => requiredPermissions.indexOf(o) < 0);

            this.browser.permissions.remove({ origins }, result => callback(result));
        });

        return new Promise<boolean>(resolve => callback = resolve);

    }
}
