const { PluginApi } = require('stash-plugin');

(function() {
    const { React } = PluginApi.libraries;
    const { FontAwesomeSolid } = PluginApi.libraries;

    // Register the MEGA Import route
    PluginApi.register.route({
        path: "/plugin/mega-import",
        component: MegaImport
    });

    // Add navigation button to the top navbar
    PluginApi.register.component({
        id: "mega-import-nav",
        component: () => {
            const Nav = () => {
                const navigate = PluginApi.libraries.ReactRouterDOM.useNavigate();
                
                return React.createElement(PluginApi.components.Button, {
                    className: "mega-import-button",
                    variant: "secondary",
                    onClick: () => navigate("/plugin/mega-import"),
                }, [
                    React.createElement(FontAwesomeSolid.faCloudDownloadAlt, {
                        className: "me-2",
                        key: "icon"
                    }),
                    "MEGA Import"
                ]);
            };
            return React.createElement(Nav);
        },
        target: "navbar"
    });

    // Listen for page changes
    PluginApi.Event.addEventListener("stash:location", (e) => {
        // We can use this to handle any cleanup or state changes when navigating
        log.Debug("Page changed: " + e.detail.data.location.pathname);
    });
})(); 