document.addEventListener('DOMContentLoaded', () => {
    // Initialize Bootstrap tooltips
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl));

    const form = document.getElementById('analysisForm');
    const dataInput = document.getElementById('data');
    const fileInput = document.getElementById('data_file');
    const columnSelect = document.getElementById('column_select');
    const columnSelectDiv = document.getElementById('columnSelectDiv');
    const referenceColumnSelect = document.getElementById('reference_column_select');
    const referenceColumnSelectDiv = document.getElementById('referenceColumnSelectDiv');
    const submitButton = form.querySelector('button[type="submit"]');
    const chartEnhancedToggle = document.getElementById('chartEnhancedToggle');
    const darkModeToggle = document.getElementById('darkModeToggle');
    const downloadFormat = document.getElementById('downloadFormat');
    let myChart = null;
    let isEnhanced = false;
    let lastChartData = null;
    let lastChartType = null;
    let lastResultData = null; // Store the last monthly result for reset
    let isDrillingDown = false; // Track drill-down state

    // **Create the modal instance once**
    const resultsModalElement = document.getElementById('resultsModal');
    const resultsModal = new bootstrap.Modal(resultsModalElement, {
        backdrop: 'static', // Prevents closing by clicking outside
        keyboard: false     // Prevents closing with ESC key
    });

    // Register Chart.js plugins
    console.log('Registering Chart.js plugins');
    if (typeof Chart === 'undefined') {
        console.error('Chart.js not loaded.');
    } else {
        Chart.register(ChartDataLabels);
        if (typeof ChartZoom !== 'undefined') {
            Chart.register(ChartZoom);
            console.log('chartjs-plugin-zoom registered successfully');
        } else {
            console.warn('chartjs-plugin-zoom not loaded. Zoom/pan features may be limited.');
        }
    }

    function updateButtonState() {
        const dataValue = dataInput.value.trim();
        const hasData = dataValue.length > 0;
        const hasFile = fileInput.files.length > 0;
        const hasColumnSelected = columnSelect.value !== '' || columnSelectDiv.style.display !== 'block';
        const isValid = (hasData || (hasFile && hasColumnSelected));

        dataInput.classList.toggle('is-invalid', hasData && dataValue.split(/,|\n/).some(v => v.trim() && isNaN(v)));
        submitButton.disabled = !isValid;
    }

    dataInput.addEventListener('input', () => {
        columnSelectDiv.style.display = 'none';
        referenceColumnSelectDiv.style.display = 'none';
        updateButtonState();
    });

    fileInput.addEventListener('change', async () => {
        if (fileInput.files.length > 0) {
            const formData = new FormData();
            formData.append('data_file', fileInput.files[0]);

            try {
                console.log('Uploading file:', fileInput.files[0].name);
                const response = await fetch('/get_columns', {
                    method: 'POST',
                    body: formData
                });
                console.log('Response status:', response.status);
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                const data = await response.json();
                console.log('Response data:', data);

                if (data.error) {
                    showError('Error: ' + data.error);
                    columnSelectDiv.style.display = 'none';
                    referenceColumnSelectDiv.style.display = 'none';
                } else if (data.columns && Array.isArray(data.columns)) {
                    columnSelect.innerHTML = '<option value="">-- Select a Column --</option>';
                    data.columns.forEach(col => {
                        const option = document.createElement('option');
                        option.value = col;
                        option.textContent = col;
                        columnSelect.appendChild(option);
                    });
                    columnSelectDiv.style.display = 'block';

                    referenceColumnSelect.innerHTML = '<option value="">-- Select a Reference Column --</option>';
                    data.columns.forEach(col => {
                        const option = document.createElement('option');
                        option.value = col;
                        option.textContent = col;
                        referenceColumnSelect.appendChild(option);
                    });
                    referenceColumnSelectDiv.style.display = 'block';

                    columnSelectDiv.style.visibility = 'visible';
                    referenceColumnSelectDiv.style.visibility = 'visible';
                    console.log('Dropdowns populated and displayed');
                } else {
                    showError('No valid columns found in the uploaded file.');
                    columnSelectDiv.style.display = 'none';
                    referenceColumnSelectDiv.style.display = 'none';
                }
            } catch (error) {
                console.error('Fetch error:', error);
                showError('Failed to fetch column names: ' + error.message);
                columnSelectDiv.style.display = 'none';
                referenceColumnSelectDiv.style.display = 'none';
            }
        } else {
            columnSelectDiv.style.display = 'none';
            referenceColumnSelectDiv.style.display = 'none';
        }
        updateButtonState();
    });

    columnSelect.addEventListener('change', () => {
        updateButtonState();
    });

    referenceColumnSelect.addEventListener('change', () => {
        updateButtonState();
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const spinner = document.getElementById('loadingSpinner');
        const errorMessage = document.getElementById('errorMessage');
        spinner.style.display = 'block';
        errorMessage.style.display = 'none'; // Hide any previous errors
        const response = await fetch('/analyze', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (data.error) {
            showError('Error: ' + data.error);
            spinner.style.display = 'none';
            return;
        }

        const taskId = data.task_id;
        const pollTask = async () => {
            const statusResponse = await fetch(`/task_status/${taskId}`);
            const status = await statusResponse.json();
            console.log('Task status:', status);
            if (status.state === 'SUCCESS') {
                lastResultData = status.result; // Store monthly result for reset
                displayResults(status.result, formData.get('chart_type'));
                spinner.style.display = 'none';
            } else if (status.state === 'FAILURE') {
                showError('Analysis failed: ' + status.status);
                spinner.style.display = 'none';
            } else {
                setTimeout(pollTask, 1000);
            }
        };
        pollTask();
        // Fallback to hide spinner after 30 seconds if stuck
        setTimeout(() => {
            if (spinner.style.display === 'block') {
                console.warn('Loading spinner timeout, hiding...');
                spinner.style.display = 'none';
                showError('Analysis is taking longer than expected. Please try again.');
            }
        }, 30000);
    });

    chartEnhancedToggle.addEventListener('change', (e) => {
        isEnhanced = e.target.checked;
        if (lastChartData && lastChartType) {
            if (myChart) {
                myChart.destroy();
                myChart = null;
            }
            displayChart(lastChartData, lastChartType, referenceColumnSelect.value);
        }
    });

    function displayResults(data, chartType, isDrillDown = false) {
        const resultText = document.getElementById('resultText');
        if (data.state === 'FAILURE') {
            showError('Analysis failed: ' + data.status);
            return;
        }

        // Handle result text display
        if (data.result && data.result.value !== undefined) {
            resultText.innerHTML = `<p><strong>${form.querySelector('#analysis_type').value}:</strong> ${data.result.value.toFixed(2)}</p>`;
        } else if (data.result && data.result.slope) {
            resultText.innerHTML = `
                <p><strong>Slope:</strong> ${data.result.slope.toFixed(2)}</p>
                <p><strong>Intercept:</strong> ${data.result.intercept.toFixed(2)}</p>
                <p><strong>R²:</strong> ${data.result.r_squared.toFixed(2)}</p>
            `;
        } else if (data.result) {
            resultText.innerHTML = `
                <p><strong>Mean:</strong> ${data.result.mean.toFixed(2)}</p>
                <p><strong>Median:</strong> ${data.result.median.toFixed(2)}</p>
                <p><strong>Std Dev:</strong> ${data.result.std_dev.toFixed(2)}</p>
                <p><strong>Variance:</strong> ${data.result.variance.toFixed(2)}</p>
                <p><strong>Min:</strong> ${data.result.min.toFixed(2)}</p>
                <p><strong>Max:</strong> ${data.result.max.toFixed(2)}</p>
                <p><strong>Quartiles:</strong> ${data.result.quartiles.map(q => q.toFixed(2)).join(', ')}</p>
            `;
        } else {
            showError('No result data available');
            return;
        }

        const values = data.chart_data.values;
        const total = values.reduce((sum, val) => sum + val, 0);
        let labels = chartType === 'box' ? [data.chart_data.label] : data.chart_data.labels;
        let chartValues = values;
        const referenceColumn = referenceColumnSelect.value;

        // Sort day-wise data by date if drilling down
        if (isDrillDown && referenceColumn && labels.length > 0) {
            const sortedIndices = labels
                .map((label, index) => ({ label, value: chartValues[index] }))
                .sort((a, b) => new Date(a.label) - new Date(b.label))
                .map(item => labels.indexOf(item.label));
            
            labels = sortedIndices.map(i => labels[i]);
            chartValues = sortedIndices.map(i => chartValues[i]);
        }

        // Detect if reference column is a date and aggregate by month/year for monthly view
        if (!isDrillDown && referenceColumn && isDateColumn(labels)) {
            const dateGroups = {};
            labels.forEach((label, i) => {
                const date = new Date(label);
                if (!isNaN(date.getTime())) { // Ensure valid date
                    const monthYear = date.toLocaleString('default', { month: 'short', year: 'numeric' });
                    if (!dateGroups[monthYear]) {
                        dateGroups[monthYear] = 0;
                    }
                    dateGroups[monthYear] += chartValues[i] || 0;
                }
            });
            // Sort labels by date (month/year in ascending order)
            labels = Object.keys(dateGroups).sort((a, b) => {
                const [monthA, yearA] = a.split(' ');
                const [monthB, yearB] = b.split(' ');
                const dateA = new Date(`${monthA} 1, ${yearA}`);
                const dateB = new Date(`${monthB} 1, ${yearB}`);
                return dateA - dateB;
            });
            chartValues = labels.map(monthYear => dateGroups[monthYear]);
        }

        const percentages = chartType !== 'box' ? chartValues.map(val => (val / total * 100).toFixed(1)) : [];

        const chartData = {
            labels: labels,
            datasets: chartType === 'box' ? [
                {
                    label: 'IQR',
                    data: [chartValues.length > 0 ? (npPercentile(chartValues, 75) - npPercentile(chartValues, 25)) : 0],
                    backgroundColor: gradientColor('#2b4066', '#1a8b9d'),
                    borderColor: '#2b4066',
                    borderWidth: 2,
                    barThickness: isEnhanced ? 70 : 50
                },
                {
                    label: 'Whiskers',
                    type: 'line',
                    data: [{x: data.chart_data.label || 'Data', y: chartValues.length > 0 ? Math.min(...chartValues) : 0}, {x: data.chart_data.label || 'Data', y: chartValues.length > 0 ? Math.max(...chartValues) : 0}],
                    borderColor: '#FF6384',
                    borderWidth: isEnhanced ? 4 : 3,
                    pointRadius: isEnhanced ? 5 : 0,
                    showLine: true,
                    borderDash: isEnhanced ? [5, 5] : []
                },
                {
                    label: 'Median',
                    type: 'line',
                    data: [{x: data.chart_data.label || 'Data', y: chartValues.length > 0 ? npPercentile(chartValues, 50) : 0}, {x: data.chart_data.label || 'Data', y: chartValues.length > 0 ? npPercentile(chartValues, 50) : 0}],
                    borderColor: '#000000',
                    borderWidth: isEnhanced ? 4 : 3,
                    pointRadius: isEnhanced ? 5 : 0,
                    showLine: true
                }
            ] : [{
                label: data.chart_data.label || form.querySelector('#data_label').value || columnSelect.value || 'Data',
                data: chartValues,
                backgroundColor: chartType === 'pie' ? chartValues.map(() => randomColor()) : gradientColor('#2b4066', '#1a8b9d'),
                borderColor: '#2b4066',
                borderWidth: 2,
                shadowColor: isEnhanced ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.2)',
                shadowBlur: isEnhanced ? 10 : 5,
                shadowOffsetX: isEnhanced ? 5 : 2,
                shadowOffsetY: isEnhanced ? 5 : 2,
                percentageData: percentages
            }]
        };

        lastChartData = chartData;
        lastChartType = chartType;

        displayChart(chartData, chartType, referenceColumn, isDrillDown); // Pass isDrillDown parameter
        document.getElementById('downloadChart').style.display = 'block';

        // Show reset zoom button for all zoomable chart types
        const zoomableCharts = ['scatter', 'line', 'bar'];
        document.getElementById('resetZoomButton').style.display = 
            zoomableCharts.includes(chartType) ? 'block' : 'none';

        const resetDrillDownButton = document.getElementById('resetDrillDownButton');
        if (resetDrillDownButton) {
            resetDrillDownButton.style.display = isDrillDown ? 'block' : 'none'; // Show back button only during drill-down
        } else {
            console.error('resetDrillDownButton not found in DOM');
        }

        // **Show the modal only if it’s not already visible**
        if (!resultsModalElement.classList.contains('show')) {
            resultsModal.show();
        }
    }

    // Reset drill-down state when modal is hidden
    resultsModalElement.addEventListener('hidden.bs.modal', () => {
        isDrillingDown = false; // Reset drill-down state
        console.log('Modal closed, drill-down state reset');
        // Ensure the parent screen regains control by removing any lingering overlays
        document.body.classList.remove('modal-open');
        const backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) {
            backdrop.remove();
        }
    });

    function displayChart(chartData, chartType, referenceColumn, isDrillDown = false) {
        const canvas = document.getElementById('resultChart');
        const container = document.querySelector('.chart-container');
        if (myChart) {
            myChart.destroy();
            myChart = null;
        }

        const dataLength = chartData.datasets[0].data.length;
        const isLargeDataset = dataLength > 50;
        const isDarkMode = darkModeToggle.checked;
        const textColor = isDarkMode ? '#ffffff' : '#333';

        // Set canvas dimensions dynamically, ensuring wide enough for bar charts
        const barSpacing = 10; // Space between bars
        const barWidth = isEnhanced ? 70 : (isLargeDataset ? 10 : 50); // Adjusted bar width
        canvas.width = chartType === 'bar' ? (dataLength * (barWidth + barSpacing)) + 100 : Math.max(600, dataLength * 50); // Wide for bars, minimum for pie
        canvas.height = 450; // Fixed height
        console.log('Canvas dimensions for', chartType, ':', { width: canvas.width, height: canvas.height });

        try {
            let chartOptions = {
                responsive: chartType === 'pie', // Responsive for pie, fixed for bar
                maintainAspectRatio: false,
                scales: (chartType === 'pie' || chartType === 'box') ? {} : {
                    y: { 
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: columnSelect.value || 'Value',
                            color: textColor,
                            font: { size: 16, weight: 'bold' }
                        },
                        ticks: {
                            color: textColor,
                            font: { size: 12 }
                        },
                        grid: {
                            color: isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'
                        }
                    },
                    x: {
                        type: chartType === 'scatter' ? 'time' : 'category', // Use time scale for scatter, category for others
                        time: chartType === 'scatter' ? {
                            unit: isDrillDown ? 'day' : 'month', // Day for drill-down, month otherwise
                            displayFormats: {
                                day: 'MMM dd, yyyy', // e.g., "Feb 01, 2023"
                                month: 'MMM yyyy'    // e.g., "Feb 2023"
                            }
                        } : undefined,
                        ticks: {
                            autoSkip: true,
                            maxRotation: 45,
                            minRotation: 45,
                            maxTicksLimit: 20,
                            color: textColor,
                            font: { size: 12 }
                        },
                        title: {
                            display: true,
                            text: referenceColumn || 'Index',
                            color: textColor,
                            font: { size: 16, weight: 'bold' }
                        },
                        grid: {
                            color: isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'
                        }
                    }
                },
                plugins: {
                    legend: { 
                        display: true,
                        position: chartType === 'pie' ? 'right' : 'top', // Right for pie, top for bar
                        labels: { 
                            color: textColor,
                            font: { size: 12, weight: 'bold' },
                            padding: 10,
                            boxWidth: 20,
                            generateLabels: function(chart) {
                                return chart.data.labels.map((label, i) => ({
                                    text: label.length > 15 ? label.substring(0, 15) + '...' : label,
                                    fillStyle: chart.data.datasets[0].backgroundColor[i],
                                    hidden: chart.getDataVisibility(i) === false,
                                    index: i,
                                    fontColor: textColor
                                }));
                            }
                        },
                        maxWidth: chartType === 'pie' ? 200 : undefined // Limit for pie only
                    },
                    animation: { 
                        duration: isEnhanced ? 1500 : 1000, 
                        easing: isEnhanced ? 'easeInOutBounce' : 'easeInOutQuad' 
                    },
                    zoom: {
                        zoom: {
                            wheel: { enabled: true },
                            pinch: { enabled: true },
                            mode: chartType === 'scatter' ? 'xy' : 'x', // XY for scatter, X for others
                            speed: 0.1 // Adjust zoom sensitivity
                        },
                        pan: {
                            enabled: true,
                            mode: chartType === 'scatter' ? 'xy' : 'x', // XY for scatter, X for others
                            speed: 20, // Adjust panning speed
                            threshold: 10, // Minimum drag distance to start panning
                            modifierKey: null // No modifier needed
                        },
                        limits: {
                            x: { 
                                min: 0, 
                                max: dataLength - 1, 
                                minRange: 5 // Minimum visible range after zoom
                            }
                        }
                    },
                    title: {
                        display: true,
                        text: `${columnSelect.value || 'Data'} vs ${referenceColumn || 'Index'}`,
                        color: textColor,
                        font: { size: 18, weight: 'bold' },
                        padding: { top: 10, bottom: 20 }
                    },
                    datalabels: {
                        color: textColor,
                        font: { size: 12, weight: 'bold' },
                        formatter: (value, context) => {
                            if (chartType === 'pie' && context.dataset.percentageData && context.dataIndex < context.dataset.percentageData.length) {
                                return `${context.dataset.percentageData[context.dataIndex]}%`;
                            }
                            return '';
                        },
                        anchor: chartType === 'pie' ? 'end' : 'end',
                        align: chartType === 'pie' ? 'end' : 'top',
                        offset: chartType === 'pie' ? 10 : 5,
                        display: (context) => {
                            if (chartType === 'pie') {
                                const total = context.dataset.data.reduce((sum, val) => sum + val, 0);
                                const value = context.dataset.data[context.dataIndex];
                                return (value / total * 100) > 5;
                            }
                            return false; // Hide datalabels for bar charts
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label, value;
                                if (chartType === 'scatter') {
                                    label = new Date(context.raw.x).toLocaleString('default', { month: 'short', year: 'numeric' });
                                    value = context.raw.y;
                                } else {
                                    label = context.label || '';
                                    value = context.raw;
                                }
                                return `${label}: ${value.toFixed(2)}`;
                            }
                        }
                    }
                },
                elements: {
                    arc: {
                        borderWidth: isEnhanced ? 3 : 2,
                        shadowColor: isEnhanced ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.2)',
                        shadowBlur: isEnhanced ? 10 : 5,
                        shadowOffsetX: isEnhanced ? 5 : 2,
                        shadowOffsetY: isEnhanced ? 5 : 2
                    },
                    bar: {
                        borderWidth: isEnhanced ? 3 : 2,
                        shadowColor: isEnhanced ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.2)',
                        shadowBlur: isEnhanced ? 15 : 5,
                        shadowOffsetX: isEnhanced ? 8 : 2,
                        shadowOffsetY: isEnhanced ? 8 : 2,
                        barThickness: Math.min(isEnhanced ? 70 : (isLargeDataset ? 10 : 50), 50) // Cap for bars
                    },
                    line: {
                        borderWidth: isEnhanced ? 4 : 2,
                        tension: isEnhanced ? 0.4 : 0,
                        borderDash: isEnhanced && chartType === 'line' ? [5, 5] : []
                    },
                    point: {
                        radius: isLargeDataset ? 2 : (isEnhanced ? 6 : 3),
                        hoverRadius: isLargeDataset ? 4 : (isEnhanced ? 8 : 5)
                    }
                },
                onClick: (event, elements) => {
                    console.log('Chart clicked, elements:', elements); // Debug: Check if click registers
                    if (elements.length > 0) {
                        const index = elements[0].index;
                        let clickedLabel;

                        if (chartType === 'scatter') {
                            // For scatter charts, use the x value (date) from the data point
                            const dataPoint = chartData.datasets[0].data[index];
                            const date = new Date(dataPoint.x);
                            clickedLabel = date.toLocaleString('default', { month: 'short', year: 'numeric' }); // e.g., "Aug 2023"
                        } else {
                            // For other charts, use the label from chartData.labels
                            clickedLabel = chartData.labels[index];
                        }

                        console.log('Clicked label:', clickedLabel, 'Reference Column:', referenceColumn); // Debug: Verify label
                        if (referenceColumn && isDateColumn(clickedLabel)) {
                            const [month, year] = clickedLabel.split(' ');
                            if (month && year) {
                                console.log('Initiating drill-down for:', { month, year }); // Debug: Confirm drill-down start
                                drillDownToDays({ month, year }, chartType);
                            } else {
                                console.error('Invalid date format in clicked label:', clickedLabel);
                                showError('Invalid date format for drill-down. Expected "MMM yyyy" (e.g., "Jan 2023").');
                            }
                        } else {
                            console.warn('Click not processed: No reference column or not a date column', {
                                referenceColumn,
                                label: clickedLabel,
                                isDate: isDateColumn(clickedLabel)
                            });
                        }
                    } else {
                        console.log('No elements clicked'); // Debug: No valid click target
                    }
                }
            };

            // Correction for scatter chart: Transform data into {x, y} format and filter invalid points
            if (chartType === 'scatter') {
                chartData.datasets[0].data = chartData.labels.map((label, index) => {
                    const x = new Date(label); // Convert label to a Date object
                    const y = chartData.datasets[0].data[index]; // Get the corresponding value
                    // Only include points with valid x (date) and y (number)
                    if (!isNaN(x.getTime()) && typeof y === 'number' && !isNaN(y)) {
                        return { x, y };
                    }
                    return null; // Exclude invalid points
                }).filter(point => point !== null); // Remove null entries
                delete chartData.labels; // Scatter charts don’t use separate labels
            }

            myChart = new Chart(canvas, {
                type: chartType === 'box' ? 'bar' : chartType,
                data: chartData,
                options: chartOptions
            });
            console.log('Chart rendered with data length:', dataLength, 'and type:', chartType);
        } catch (error) {
            showError('Failed to render chart: ' + error.message);
            console.error('Chart render error:', error);
        }
    }

    function isDateColumn(labels) {
        // Handle both single string and array of labels
        if (typeof labels === 'string') {
            console.log('Checking single label for isDateColumn:', labels);
            // Support both monthly (MMM yyyy) and day-wise (yyyy-MM-dd) formats
            const monthlyMatch = labels.match(/^(\w{3,4} \d{4})$/); // Match 3 or 4 letter months (e.g., "Jan", "Sept")
            const dailyMatch = labels.match(/^\d{4}-\d{2}-\d{2}$/); // Match yyyy-MM-dd (e.g., "2023-02-28")
            if (monthlyMatch) {
                const [month, year] = labels.split(' ');
                const date = new Date(`${month} 1, ${year}`);
                const isValid = !isNaN(date.getTime());
                console.log(`Checking date format for ${labels}: Valid=${isValid}`);
                return isValid;
            } else if (dailyMatch) {
                const date = new Date(labels);
                const isValid = !isNaN(date.getTime());
                console.log(`Checking date format for ${labels}: Valid=${isValid}`);
                return isValid;
            }
            console.warn(`Label ${labels} does not match date format (e.g., 'Jan 2023' or '2023-02-28')`);
            return false;
        } else if (!labels || !Array.isArray(labels)) {
            console.warn('Invalid labels for isDateColumn:', labels);
            return false;
        }

        // Handle array of labels
        return labels.every(label => {
            const monthlyMatch = label.match(/^(\w{3,4} \d{4})$/); // Match 3 or 4 letter months
            const dailyMatch = label.match(/^\d{4}-\d{2}-\d{2}$/); // Match yyyy-MM-dd
            if (monthlyMatch) {
                const [month, year] = label.split(' ');
                const date = new Date(`${month} 1, ${year}`);
                const isValid = !isNaN(date.getTime());
                console.log(`Checking date format for ${label}: Valid=${isValid}`);
                return isValid;
            } else if (dailyMatch) {
                const date = new Date(label);
                const isValid = !isNaN(date.getTime());
                console.log(`Checking date format for ${label}: Valid=${isValid}`);
                return isValid;
            }
            console.warn(`Label ${label} does not match date format (e.g., 'Jan 2023' or '2023-02-28')`);
            return false;
        });
    }

    async function drillDownToDays(monthYear, chartType) {
        isDrillingDown = true;
        const formData = new FormData(form);
        formData.set('drill_down', JSON.stringify(monthYear));

        try {
            console.log('Drilling down to:', monthYear);
            const response = await fetch('/analyze', {
                method: 'POST',
                body: formData
            });
            console.log('Drill-down response status:', response.status, 'Response OK:', response.ok);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            const data = await response.json();
            console.log('Drill-down response data:', data);

            if (data.error) {
                showError('Error: ' + data.error);
                isDrillingDown = false;
                return;
            }

            const taskId = data.task_id;
            const pollTask = async () => {
                const statusResponse = await fetch(`/task_status/${taskId}`);
                const status = await statusResponse.json();
                console.log('Drill-down task status:', status);
                if (status.state === 'SUCCESS') {
                    lastResultData = status.result; // Update lastResultData with drill-down result (optional)
                    displayResults(status.result, chartType, true); // Pass drill-down flag
                    const resetDrillDownButton = document.getElementById('resetDrillDownButton');
                    if (resetDrillDownButton) {
                        resetDrillDownButton.style.display = 'block'; // Show back button
                    } else {
                        console.error('resetDrillDownButton not found in DOM');
                    }
                    isDrillingDown = false;
                } else if (status.state === 'FAILURE') {
                    showError('Drill-down failed: ' + status.status);
                    isDrillingDown = false;
                } else {
                    setTimeout(pollTask, 1000);
                }
            };
            pollTask();
        } catch (error) {
            console.error('Drill-down error:', error);
            showError('Failed to drill down: ' + error.message);
            isDrillingDown = false;
        }
    }

    async function resetToMonthly() {
        if (isDrillingDown || !lastResultData) return;

        isDrillingDown = true; // Prevent multiple simultaneous requests
        const formData = new FormData(form);
        formData.delete('drill_down'); // Remove drill-down parameter to get monthly data

        try {
            const spinner = document.getElementById('loadingSpinner');
            const errorMessage = document.getElementById('errorMessage');
            spinner.style.display = 'block';
            errorMessage.style.display = 'none'; // Hide any previous errors

            const response = await fetch('/analyze', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (data.error) {
                showError('Error: ' + data.error);
            } else {
                const taskId = data.task_id;
                const pollTask = async () => {
                    const statusResponse = await fetch(`/task_status/${taskId}`);
                    const status = await statusResponse.json();
                    console.log('Reset to monthly task status:', status);
                    if (status.state === 'SUCCESS') {
                        lastResultData = status.result; // Update with monthly result
                        displayResults(status.result, formData.get('chart_type'), false); // Display monthly view
                        const resetDrillDownButton = document.getElementById('resetDrillDownButton');
                        if (resetDrillDownButton) {
                            resetDrillDownButton.style.display = 'none'; // Hide back button
                        }
                        spinner.style.display = 'none';
                    } else if (status.state === 'FAILURE') {
                        showError('Reset to monthly failed: ' + status.status);
                        spinner.style.display = 'none';
                    } else {
                        setTimeout(pollTask, 1000);
                    }
                };
                pollTask();
            }
        } catch (error) {
            console.error('Reset to monthly error:', error);
            showError('Failed to reset to monthly: ' + error.message);
        } finally {
            isDrillingDown = false;
        }
    }

    function showError(message) {
        const errorMessage = document.getElementById('errorMessage');
        if (errorMessage) {
            errorMessage.textContent = message;
            errorMessage.style.display = 'block';
            // Auto-hide after 5 seconds
            setTimeout(() => {
                errorMessage.style.display = 'none';
            }, 5000);
        } else {
            alert(message); // Fallback if errorMessage div isn’t found
        }
    }

    function sampleData(chartData, maxPoints) {
        const dataLength = chartData.datasets[0].data.length;
        if (dataLength <= maxPoints) return chartData;

        const step = Math.floor(dataLength / maxPoints);
        const sampledLabels = [];
        const sampledValues = [];
        const sampledPercentages = [];

        for (let i = 0; i < dataLength; i += step) {
            sampledLabels.push(chartData.labels[i]);
            sampledValues.push(chartData.datasets[0].data[i]);
            if (chartData.datasets[0].percentageData) {
                sampledPercentages.push(chartData.datasets[0].percentageData[i]);
            }
        }

        return {
            labels: sampledLabels,
            datasets: [{
                ...chartData.datasets[0],
                data: sampledValues,
                percentageData: sampledPercentages.length > 0 ? sampledPercentages : undefined
            }]
        };
    }

    function npPercentile(arr, percentile) {
        const sorted = arr.slice().sort((a, b) => a - b);
        const index = (percentile / 100) * (sorted.length - 1);
        const lower = Math.floor(index);
        const fraction = index - lower;
        if (lower + 1 < sorted.length) {
            return sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
        }
        return sorted[lower];
    }

    function gradientColor(startColor, endColor) {
        const ctx = document.createElement('canvas').getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, startColor);
        gradient.addColorStop(1, endColor);
        return gradient;
    }

    function randomColor() {
        return `rgba(${Math.floor(Math.random() * 255)}, ${Math.floor(Math.random() * 255)}, ${Math.floor(Math.random() * 255)}, 0.7)`;
    }

    document.getElementById('darkModeToggle').addEventListener('change', (e) => {
        document.body.classList.toggle('dark-mode', e.target.checked);
        document.querySelector('.container').classList.toggle('dark-mode', e.target.checked);
        document.querySelectorAll('.card').forEach(card => card.classList.toggle('dark-mode', e.target.checked));
        document.querySelectorAll('h1, h2, h3').forEach(h => h.classList.toggle('dark-mode', e.target.checked));
        document.querySelector('.sidebar').classList.toggle('dark-mode', e.target.checked);
        if (lastChartData && lastChartType) {
            if (myChart) {
                myChart.destroy();
                myChart = null;
            }
            displayChart(lastChartData, lastChartType, referenceColumnSelect.value);
        }
    });

    document.getElementById('save').addEventListener('click', () => {
        const formData = Object.fromEntries(new FormData(form));
        const blob = new Blob([JSON.stringify(formData)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'analysis.json';
        a.click();
    });

    document.getElementById('load').addEventListener('change', (e) => {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = (event) => {
            const data = JSON.parse(event.target.result);
            document.getElementById('data').value = data.data || '';
            document.getElementById('data_label').value = data.data_label || '';
            document.getElementById('analysis_type').value = data.analysis_type;
            document.getElementById('chart_type').value = data.chart_type;
            document.getElementById('cleaning_option').value = data.cleaning_option || '';
            if (data.column_select) {
                columnSelect.value = data.column_select;
                columnSelectDiv.style.display = 'block';
            }
            if (data.reference_column_select) {
                referenceColumnSelect.value = data.reference_column_select;
                referenceColumnSelectDiv.style.display = 'block';
            }
            updateButtonState();
        };
        reader.readAsText(file);
    });

    document.getElementById('downloadChart').addEventListener('click', () => {
        if (myChart) {
            const format = downloadFormat.value;
            const link = document.createElement('a');

            if (format === 'png') {
                link.href = myChart.toBase64Image();
                link.download = 'chart.png';
                link.click();
            } else if (format === 'jpeg') {
                link.href = myChart.toBase64Image('image/jpeg');
                link.download = 'chart.jpg';
                link.click();
            } else if (format === 'pdf') {
                const imgData = myChart.toBase64Image();
                const { jsPDF } = window.jspdf;
                const pdf = new jsPDF('landscape');
                const imgProps = pdf.getImageProperties(imgData);
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
                pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
                pdf.save('chart.pdf');
            }
        } else {
            showError('No chart available to download.');
        }
    });

    document.getElementById('exportData').addEventListener('click', () => {
        if (!lastResultData) {
            showError('No analysis data available to export. Please run an analysis first.');
            return;
        }

        const exportData = {
            formData: Object.fromEntries(new FormData(form)),
            resultData: lastResultData
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'analysis_results.json';
        a.click();
    });

    document.getElementById('resetZoomButton').addEventListener('click', () => {
        if (myChart) {
            myChart.resetZoom();
        }
    });

    document.getElementById('resetDrillDownButton')?.addEventListener('click', resetToMonthly);

    updateButtonState();
});