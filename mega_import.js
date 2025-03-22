"use strict";
(function() {
  const api = window.PluginApi;
  const React = api.React;
  const { Button } = api.libraries.Bootstrap;
  const { faCloudDownloadAlt, faSpinner } = api.libraries.FontAwesomeSolid;
  const { Icon } = api.components;

  // Define main component with loading states
  const MegaImportPage = () => {
    const [isLoading, setIsLoading] = React.useState(false);
    const [megaUrl, setMegaUrl] = React.useState('');
    const [results, setResults] = React.useState(null);
    const toast = api.hooks.useToast(); // Toast notifications
    
    const handleImport = async () => {
      if (!megaUrl) {
        toast.error("Please enter a MEGA.nz URL");
        return;
      }
      
      setIsLoading(true);
      try {
        // Call the plugin task
        const result = await api.utils.StashService.runPluginTask(
          "mega_import", 
          "Import from MEGA", 
          { url: megaUrl }
        );
        setResults(result);
        toast.success("Import completed successfully");
      } catch (error) {
        console.error("Import failed:", error);
        toast.error("Import failed: " + (error.message || "Unknown error"));
      } finally {
        setIsLoading(false);
      }
    };
    
    return React.createElement(
      "div",
      { className: "mega-import-container" },
      React.createElement("h2", null, "MEGA.nz Import"),
      React.createElement(
        "div",
        { className: "form-group" },
        React.createElement("label", { htmlFor: "mega-url" }, "MEGA.nz URL"),
        React.createElement("input", {
          type: "text",
          id: "mega-url",
          className: "form-control text-input",
          value: megaUrl,
          onChange: (e) => setMegaUrl(e.target.value),
          placeholder: "https://mega.nz/file/...",
          disabled: isLoading
        })
      ),
      React.createElement(
        Button,
        {
          className: "btn-primary",
          onClick: handleImport,
          disabled: isLoading
        },
        isLoading ? [
          React.createElement(Icon, { icon: faSpinner, spin: true }),
          " Importing..."
        ] : "Import from MEGA"
      ),
      isLoading && React.createElement(
        "div",
        { className: "loader mt-3" },
        React.createElement("span", null, "Importing from MEGA.nz..."),
        React.createElement(
          "div",
          { className: "progress" },
          React.createElement("div", {
            className: "progress-bar",
            role: "progressbar",
            style: { width: "100%" }
          })
        )
      ),
      results && React.createElement(
        "div",
        { className: "results mt-3" },
        React.createElement("h3", null, "Import Results"),
        React.createElement("pre", null, JSON.stringify(results, null, 2))
      )
    );
  };

  // Register the route
  api.register.route({
    path: "/plugin/mega-import",
    component: MegaImportPage
  });

  // Add navigation button
  api.register.navLinks({
    id: "mega-import",
    label: "MEGA Import",
    icon: React.createElement(Icon, { icon: faCloudDownloadAlt }),
    path: "/plugin/mega-import",
    parentId: "tools"
  });

  // Log successful loading
  console.log("MEGA Import plugin loaded successfully");
})(); 