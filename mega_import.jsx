import React, { useState, useEffect } from 'react';
import { formatBytes, formatDate } from './utils/format';

const MegaImport = () => {
    const [files, setFiles] = useState([]);
    const [currentPath, setCurrentPath] = useState('/');
    const [selectedFiles, setSelectedFiles] = useState(new Set());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);

    // Load initial file list
    useEffect(() => {
        loadFiles();
    }, []);

    const loadFiles = async () => {
        try {
            setLoading(true);
            setError(null);
            const result = await PluginApi.runPluginOperation('mega_import', {
                operation: 'main',
                path: currentPath
            });
            
            if (result.Error) {
                setError(result.Error);
                return;
            }

            setFiles(result.Output.files);
            setCurrentPath(result.Output.currentPath);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleFileSelect = (filePath) => {
        const newSelected = new Set(selectedFiles);
        if (newSelected.has(filePath)) {
            newSelected.delete(filePath);
        } else {
            newSelected.add(filePath);
        }
        setSelectedFiles(newSelected);
    };

    const handleImport = async () => {
        try {
            setLoading(true);
            setError(null);
            setSuccess(null);

            for (const filePath of selectedFiles) {
                const result = await PluginApi.runPluginOperation('mega_import', {
                    operation: 'handleFileSelect',
                    filePath: filePath
                });

                if (result.Error) {
                    setError(result.Error);
                    return;
                }
            }

            setSuccess('Files imported successfully');
            setSelectedFiles(new Set());
            loadFiles(); // Refresh file list
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleNavigate = async (newPath) => {
        try {
            setLoading(true);
            setError(null);
            const result = await PluginApi.runPluginOperation('mega_import', {
                operation: 'handleNavigate',
                path: newPath
            });

            if (result.Error) {
                setError(result.Error);
                return;
            }

            setFiles(result.Output.files);
            setCurrentPath(result.Output.currentPath);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="mega-import-container">
            <div className="mega-navigation">
                <div className="mega-path">{currentPath}</div>
                <div className="mega-buttons">
                    <button 
                        className="mega-button"
                        onClick={() => handleNavigate('/')}
                        disabled={loading || currentPath === '/'}
                    >
                        Root
                    </button>
                    <button 
                        className="mega-button"
                        onClick={() => handleNavigate(path.dirname(currentPath))}
                        disabled={loading || currentPath === '/'}
                    >
                        Up
                    </button>
                    <button 
                        className="mega-button mega-import-button"
                        onClick={handleImport}
                        disabled={loading || selectedFiles.size === 0}
                    >
                        <img 
                            src="/plugin/mega_import/assets/Mega_logo.svg" 
                            alt="MEGA" 
                            className="mega-logo"
                        />
                        Import from MEGA ({selectedFiles.size})
                    </button>
                </div>
            </div>

            {error && (
                <div className="mega-error">
                    {error}
                </div>
            )}

            {success && (
                <div className="mega-success">
                    {success}
                </div>
            )}

            {loading ? (
                <div className="mega-loading">
                    <div className="mega-loading-spinner" />
                </div>
            ) : (
                <div className="mega-file-list">
                    {files.map(file => (
                        <div
                            key={file.path}
                            className={`mega-file-item ${selectedFiles.has(file.path) ? 'selected' : ''}`}
                            onClick={() => handleFileSelect(file.path)}
                        >
                            <div className="mega-file-name">
                                {file.type === 'directory' ? '📁 ' : '📄 '}
                                {file.name}
                            </div>
                            <div className="mega-file-info">
                                {file.type !== 'directory' && (
                                    <span className="mega-file-size">
                                        {formatBytes(file.size)}
                                    </span>
                                )}
                                <span className="mega-file-date">
                                    {formatDate(file.modified)}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default MegaImport; 