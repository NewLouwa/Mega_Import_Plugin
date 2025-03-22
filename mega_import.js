"use strict";
(function() {
  const api = window.PluginApi;
  const React = api.React;
  const { Button, Modal } = api.libraries.Bootstrap;
  const { faCloudDownloadAlt, faSpinner } = api.libraries.FontAwesomeSolid;
  const { Icon } = api.components;

  // Define MEGA logo as inline SVG
  const megaLogoSVG = '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="20" height="20" viewBox="0 0 361.4 361.4"><path fill="#d9272e" d="M180.7 0C80.9 0 0 80.9 0 180.7c0 99.8 80.9 180.7 180.7 180.7 99.8 0 180.7-80.9 180.7-180.7C361.4 80.9 280.5 0 180.7 0Zm93.8 244.6c0 3.1-2.5 5.6-5.6 5.6h-23.6c-3.1 0-5.6-2.5-5.6-5.6v-72.7c0-.6-.7-.9-1.2-.5l-50 50c-4.3 4.3-11.4 4.3-15.7 0l-50-50c-.4-.4-1.2-.1-1.2.5v72.7c0 3.1-2.5 5.6-5.6 5.6H92.4c-3.1 0-5.6-2.5-5.6-5.6V116.8c0-3.1 2.5-5.6 5.6-5.6h16.2c2.9 0 5.8 1.2 7.9 3.3l62.2 62.2c1.1 1.1 2.8 1.1 3.9 0l62.2-62.2c2.1-2.1 4.9-3.3 7.9-3.3h16.2c3.1 0 5.6 2.5 5.6 5.6v127.8z"/></svg>';

  // Larger version for modal header
  const megaLogoSVGLarge = '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="30" height="30" viewBox="0 0 361.4 361.4"><path fill="#d9272e" d="M180.7 0C80.9 0 0 80.9 0 180.7c0 99.8 80.9 180.7 180.7 180.7 99.8 0 180.7-80.9 180.7-180.7C361.4 80.9 280.5 0 180.7 0Zm93.8 244.6c0 3.1-2.5 5.6-5.6 5.6h-23.6c-3.1 0-5.6-2.5-5.6-5.6v-72.7c0-.6-.7-.9-1.2-.5l-50 50c-4.3 4.3-11.4 4.3-15.7 0l-50-50c-.4-.4-1.2-.1-1.2.5v72.7c0 3.1-2.5 5.6-5.6 5.6H92.4c-3.1 0-5.6-2.5-5.6-5.6V116.8c0-3.1 2.5-5.6 5.6-5.6h16.2c2.9 0 5.8 1.2 7.9 3.3l62.2 62.2c1.1 1.1 2.8 1.1 3.9 0l62.2-62.2c2.1-2.1 4.9-3.3 7.9-3.3h16.2c3.1 0 5.6 2.5 5.6 5.6v127.8z"/></svg>';

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
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        Button,
        {
          className: "nav-utility minimal",
          title: "MEGA Import",
          onClick: onClickHandler,
          dangerouslySetInnerHTML: { __html: megaLogoSVG }
        }
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
        React.createElement(
          "div",
          { className: "modal-title-with-logo" },
          React.createElement("span", {
            dangerouslySetInnerHTML: { __html: megaLogoSVGLarge },
            className: "mega-logo-header"
          }),
          React.createElement(Modal.Title, null, "MEGA.nz Import")
        )
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