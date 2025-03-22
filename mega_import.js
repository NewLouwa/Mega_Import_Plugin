"use strict";
(function() {
  const api = window.PluginApi;
  const React = api.React;
  const { Button, Modal } = api.libraries.Bootstrap;
  const { faCloudDownloadAlt, faSpinner } = api.libraries.FontAwesomeSolid;
  const { Icon } = api.components;

  // Define main component with loading states
  const MegaImportComponent = () => {
    const [display, setDisplay] = React.useState(false);
    const [isLoading, setIsLoading] = React.useState(false);
    const [megaUrl, setMegaUrl] = React.useState('');
    const [results, setResults] = React.useState(null);
    const toast = api.hooks.useToast(); // Toast notifications
    
    const enableModal = () => setDisplay(true);
    const disableModal = () => setDisplay(false);
    
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
      React.Fragment,
      null,
      React.createElement(NavButton, { onClickHandler: enableModal }),
      React.createElement(MegaImportModal, {
        displayState: display,
        onCloseHandler: disableModal,
        megaUrl: megaUrl,
        setMegaUrl: setMegaUrl,
        handleImport: handleImport,
        isLoading: isLoading,
        results: results
      })
    );
  };

  // NavBar Button Component
  const NavButton = ({ onClickHandler }) => {
    const { Icon } = api.components;
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        Button,
        {
          className: "nav-utility minimal",
          title: "MEGA Import",
          onClick: onClickHandler,
        },
        React.createElement(Icon, { icon: faCloudDownloadAlt })
      )
    );
  };

  // Modal Component
  const MegaImportModal = ({
    displayState,
    onCloseHandler,
    megaUrl,
    setMegaUrl,
    handleImport,
    isLoading,
    results
  }) => {
    return React.createElement(
      Modal,
      { 
        show: displayState, 
        onHide: onCloseHandler,
        size: "lg"
      },
      React.createElement(
        Modal.Header,
        { closeButton: true },
        React.createElement(Modal.Title, null, "MEGA.nz Import")
      ),
      React.createElement(
        Modal.Body,
        null,
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
      ),
      React.createElement(
        Modal.Footer,
        null,
        React.createElement(
          Button,
          { variant: "secondary", onClick: onCloseHandler },
          "Close"
        ),
        React.createElement(
          Button,
          { 
            variant: "primary", 
            onClick: handleImport,
            disabled: isLoading
          },
          isLoading ? [
            React.createElement(Icon, { icon: faSpinner, spin: true }),
            " Importing..."
          ] : "Import from MEGA"
        )
      )
    );
  };

  // Add to navbar using patch.before
  api.patch.before("MainNavBar.UtilityItems", function (props) {
    return [
      {
        children: React.createElement(
          React.Fragment,
          null,
          props.children,
          React.createElement(MegaImportComponent, null)
        ),
      },
    ];
  });

  // Log successful loading
  console.log("MEGA Import plugin loaded successfully");
})(); 