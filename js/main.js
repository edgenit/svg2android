/* Helper methods */
String.prototype.f = function () {
    var s = this,
        i = arguments.length;

    while (i--) {
        s = s.replace(new RegExp('\\{' + i + '\\}', 'gm'), arguments[i]);
    }
    return s;
};

String.prototype.repeat = function (num) {
    return new Array(num + 1).join(this);
};

function pushUnique(array, item) {
    if (array.indexOf(item) == -1) {
        array.push(item);
        return true;
    }
    return false;
}


function toBool(s, defValue) {
    if (typeof s === "undefined") {
        return typeof defValue !== "undefined" ? defValue : false;
    }
    return "false" !== s;
}

if (typeof String.prototype.endsWith !== 'function') {
    String.prototype.endsWith = function (suffix) {
        return this.indexOf(suffix, this.length - suffix.length) !== -1;
    };
}

if (typeof String.prototype.startsWith !== 'function') {
    String.prototype.startsWith = function (str) {
        return this.indexOf(str) == 0;
    };
}

jQuery.fn.reverse = [].reverse;

/* ------ */

var groupData = { groupSize:0, zip:null, log:[], errors:0, files:[]};

var fileReaderOpts = {
    dragClass: "drag", readAsDefault: "Text", on: {
        load: function (e, file) {
            if (groupData.groupSize == 1) {
                loadFile(e, file, false)
            } else {
                groupData.files.push({e: e, file: file});
            }
        },
        groupstart: function (g) {
            resetGroupData();
            groupData.zip = new JSZip();
            groupData.groupSize = g.files.length;
        },
        groupend: function (g) {
            //Multiple files
            if (groupData.groupSize > 1) {
                groupData.groupSize = 0;
                var dlg = $('#dlg-files');
                var btnPrimary = dlg.find(".btn-primary");

                refreshSettings();
                dlg.find("#files-count").text(groupData.files.length);
                btnPrimary.text("Export");
                dlg.modal().on();

                btnPrimary.removeClass("disabled");

                btnPrimary.unbind("click");
                btnPrimary.on("click", function () {
                    if (btnPrimary.hasClass("disabled")) return;

                    btnPrimary.addClass("disabled");
                    btnPrimary.text("Please wait ...");

                    //To prevent UI lag
                    setTimeout(function () {
                        for (var i = 0; i < groupData.files.length; i++) {
                            var f = groupData.files[i];
                            loadFile(f.e, f.file, true);
                        }

                        groupData.log = "<h2>Files converted: " +  (groupData.files.length - groupData.errors) + " / " + groupData.files.length + "</h2>" + groupData.log;
                        groupData.zip.file("log.html", groupData.log);

                        saveAs(groupData.zip.generate({type: "blob"}), "export.zip");
                        dlg.modal("hide");
                    }, 250);
                });

                dlg.unbind("hidden.bs.modal");
                dlg.on("hidden.bs.modal", function () {
                    resetGroupData();
                })
            }
        }
    }
};

if (typeof FileReader === "undefined") {
    $('#dropzone, #dropzone-dialog').hide();
    $('#compat-error').show();
} else {
    $('#dropzone, #dropzone-dialog').fileReaderJS(fileReaderOpts);
}

//Copy settings to dialog
var dlg = $('#dlg-files');
dlg.find('.modal-body').html($("#settings-area").clone());

/* ------ */

var DRAW_LINE = "l"; //used as default parameter when no found in path
var START_PATH = "M";
var END_PATH = "Z";
var INDENT = "    ";

var pathsParsedCount = 0;
var generatedOutput = "";
var lastFileName = "";
var lastFileData;
var warnings = [];
var svgStyles = {};

function loadFile(e, file, multipleFiles) {
    lastFileName = file.name;
    refreshSettings();

    if (multipleFiles) {
        parseMultipleFiles(e.target.result)
    } else {
        parseSingleFile(e.target.result);
    }
}

function resetGroupData() {
    groupData.zip = new JSZip();
    groupData.log = [];
    groupData.files = [];
    groupData.errors = 0;
    groupData.groupSize = 0;
}

function refreshSettings() {
    $(".opt-id-as-name").prop("checked", toBool(localStorage.useIdAsName));
    $(".bake-transforms").prop("checked", toBool(localStorage.bakeTransforms));
    $(".clear-groups").prop("checked", toBool(localStorage.clearGroups, true));
    $(".add-vector-compat").prop("checked", toBool(localStorage.addVectorCompat));
}

function extractFileNameWithoutExt(filename) {
    var dotIndex = filename.lastIndexOf(".");
    if (dotIndex > -1) {
        return filename.substr(0, dotIndex);
    } else {
        return filename;
    }
}

//Main parse & convert logic
function recursiveTreeWalk(parent, groupLevel) {
    parent.children().each(function () {
        var current = $(this);
        if (current.is("g") && current.children().length > 0) { //Group tag, ignore empty groups
            var group = parseGroup(current);
            var ignoreGroup = !(toBool(localStorage.clearGroups, true) && !group.isSet);
            if (ignoreGroup) printGroupStart(group, groupLevel);

            if (ignoreGroup) groupLevel++;
            recursiveTreeWalk(current, groupLevel);
            if (ignoreGroup) groupLevel--;

            if (ignoreGroup) printGroupEnd(groupLevel);
        } else if (current.is("path")) {
            var pathD = parsePathD(current);
            if (pathD != null) {
                printPath(pathD, getStyles(current), groupLevel);
            } else {
                pushUnique(warnings, "found path(s) without data (empty or invalid parameter <i>d</i>)");
            }
        } else if (current.is("line")) {
            printPath(ShapeConverter.convertLine(current), getStyles(current), groupLevel);
        } else if (current.is("rect")) {
            printPath(ShapeConverter.convertRect(current), getStyles(current), groupLevel);
        } else if (current.is("circle")) {
            printPath(ShapeConverter.convertCircle(current), getStyles(current), groupLevel);
        } else if (current.is("ellipse")) {
            printPath(ShapeConverter.convertEllipse(current), getStyles(current), groupLevel);
        } else if (current.is("polyline")) {
            printPath(ShapeConverter.convertPolygon(current, true), getStyles(current), groupLevel);
        } else if (current.is("polygon")) {
            printPath(ShapeConverter.convertPolygon(current, false), getStyles(current), groupLevel);
        } else if (current.is("text")) {
            pushUnique(warnings, "<i>text</i> element is not supported, export all text into path");
        }
    });
}

function preprocessReferences(svg, grouplevel) {
    svg.find("use").each(function () {
        var current = $(this);
        substituteUseRef(svg, current);
    });
}

function getStyles(el) {
    var styles = parseStyles(el);

    var parentStyles = null;

    //Inherit all parent group styles in reversed order (to override them correctly)
    el.parents("g").reverse().each(function () {
        var current = $(this);
        if (parentStyles == null) {
            parentStyles = [];
        }
        jQuery.extend(parentStyles, parseStyles(current));
    });

    //Do not propagate id from group to childrens
    if (parentStyles != null && typeof parentStyles["id"] !== "undefined") {
        parentStyles["id"] = undefined;
    }

    return [styles, parentStyles];
}

function substituteUseRef(parent, current) {
    var href = current.attr("xlink:href");
    if (typeof href !== "undefined") {
        href = href.trim();
        //Check if valid href
        if (href.length > 1 && href.startsWith("#")) {
            //Find definition in svg
            var defs = $(parent).find("[id='" + href.substr(1) + "']");
            if (defs.length) {
                defs = defs.clone();

                //Copy overriding attributes into children
                $.each(current.prop("attributes"), function () {
                    defs.attr(this.name, this.value);
                });

                current.replaceWith(defs);
            } else {
                console.warn("Found <use> tag but did not found appropriate block in <defs> for id " + href);
            }
        }
    }
}

function parseGroup(groupTag) {
    var transform = groupTag.attr("transform");
    var id = groupTag.attr("id");
    var groupTransform = {transformX: 0, transformY: 0, scaleX: 1, scaleY: 1, rotate:0, rotatePivotX:-1, rotatePivotY:-1, id:"", isSet:false};
    if (typeof transform !== "undefined") {
        var regex = /((\w|\s)+)\(([^)]+)/mg;
        var result;
        while (result = regex.exec(transform)) {
            var split = result[3].split(/[,\s]+/);
            var transformName = result[1].trim();
            if (transformName == "translate") {
                groupTransform.transformX = split[0];
                groupTransform.transformY = split[1] || 0;
                groupTransform.isSet = true;
            } else if (transformName == "scale") {
                groupTransform.scaleX = split[0];
                groupTransform.scaleY = split[1] || 0;
                groupTransform.isSet = true;
            } else if (transformName == "rotate") {
                groupTransform.rotate = split[0];
                groupTransform.rotatePivotX = split[1] || -1;
                groupTransform.rotatePivotY = split[2] || -1;
                groupTransform.isSet = true;
            } else {
                pushUnique(warnings, "group transform '<i>" + transformName + "</i>' is not supported, use option <i>Bake transforms into path</i>")
            }
        }
    }
    if (typeof id !== "undefined") {
        groupTransform.id = id;
    }

    return groupTransform;
}

function parsePathD(pathData) {
    var path = pathData.attr("d");

    if (typeof path === "undefined") {
        return null;
    }

    path = path.replace(/\s{2,}/g, " "); //replace extra spaces

    if (path.match(/-?\d*\.?\d+e[+-]?\d+/g)) {
        pushUnique(warnings, "found some numbers with scientific E notation in pathData which Android probably does not support. " +
        "Please fix It manually by editing your editor precision or manually by editing pathData");
    }

    //Check path If contains draw otherwise use default l
    var pathStart = false, bigM = false, skipMove = false, stop = false;
    var pathRebuild = "";
    path.split(" ").forEach(function (t) {
        if (stop) {
            pathRebuild += t + " ";
            return;
        }

        if (t.toUpperCase() == START_PATH) {
            pathStart = true;
            bigM = t == START_PATH;
        } else if (skipMove && pathStart) {
            if (!(t.indexOf(",") == -1 && isNaN(t))) {
                t = (bigM ? DRAW_LINE.toUpperCase() : DRAW_LINE) + " " + t;
            }
            stop = true;
        } else if (pathStart) {
            skipMove = true;
        }

        pathRebuild += t + " ";
    });

    path = fixPathPositioning(pathRebuild);
    path = fixNumberFormatting(path);

    if (!path.endsWith(" ")) {
        path += " ";
    }

    return wordwrap(path.trim(), 80, "\n");
}


function parseStyles(path) {
    //Convert attributes to style
    var attributes = path[0].attributes;
    var stylesArray = {};
    for (var n = 0; n < attributes.length; n++) {
        var name = attributes[n].name;
        var value = attributes[n].value;
        if (name == "style") {
            //Fix CSSJSON bug
            if (!value.endsWith(";")) {
                value += ";"
            }
            var cssAttributes = CSSJSON.toJSON(value).attributes;
            parseCssAttributes(stylesArray, cssAttributes);
        } else if (name == "class") {
            var val = "." + value.trim();
            if (typeof svgStyles.children !== "undefined" && typeof svgStyles.children[val] !== "undefined") {
                parseCssAttributes(stylesArray, svgStyles.children[val].attributes);
            }
        } else {
            stylesArray[name] = value;
            checkAttribute(name, value);
        }
    }

    return stylesArray;
}

function parseCssAttributes(stylesArray, cssAttributes) {
    for (var key in cssAttributes) {
        if (cssAttributes.hasOwnProperty(key)) {
            stylesArray[key] = cssAttributes[key];

            checkAttribute(key, cssAttributes[key]);
        }
    }
}

function checkAttribute(key, val) {
    if ((key == "fill" || key == "stroke") && val.startsWith("url")) {
        pushUnique(warnings, "found fill(s) or stroke(s) which uses <i>url()</i> (gradients and patterns are not supported in Android)");
    }
}

function printGroupStart(groupTransform, groupLevel) {
    generatedOutput += INDENT.repeat(groupLevel + 1) + '<group\n';
    if (toBool(localStorage.useIdAsName)) generatedOutput += generateAttr("name", groupTransform.id, groupLevel + 1, "");
    generatedOutput += generateAttr("translateX", groupTransform.transformX, groupLevel + 1, 0);
    generatedOutput += generateAttr("translateY", groupTransform.transformY, groupLevel + 1, 0);
    generatedOutput += generateAttr("scaleX", groupTransform.scaleX, groupLevel + 1, 1);
    generatedOutput += generateAttr("scaleY", groupTransform.scaleY, groupLevel + 1, 1);
    if (generatedOutput.endsWith("\n")) {
        generatedOutput = generatedOutput.substr(0, generatedOutput.length - 1);
    }
    generatedOutput += ">\n";
}

function printGroupEnd(groupLevel) {
    generatedOutput += INDENT.repeat(groupLevel + 1) + '</group>\n';
}

function printPath(pathData, stylesArray, groupLevel) {
    var styles = stylesArray[0];
    var parentGroupStyles = stylesArray[1];

    if (pathData == null) {
        return;
    }

    if (styles.hasOwnProperty("transform")) {
        pushUnique(warnings, "transforms on path are not supported, use option <i>Bake transforms into path</i>")
    }

    if (parentGroupStyles != null) {
        //Inherit styles from group first
        for (var styleName in parentGroupStyles) {
            if (typeof styles[styleName] === "undefined") {
                styles[styleName] = parentGroupStyles[styleName];
            }
        }
    }
    //Parent opacity setting - multiply fill-opacity and stroke-opacity
    var opacity = styles["opacity"];
    if (typeof opacity !== "undefined") {
        if (typeof styles["fill-opacity"] !== "undefined") {
            styles["fill-opacity"] *= opacity;
        } else {
            styles["fill-opacity"] = opacity;
        }
        if (typeof styles["stroke-opacity"] !== "undefined") {
            styles["stroke-opacity"] *= opacity;
        } else {
            styles["stroke-opacity"] = opacity;
        }
    }

    //If fill is omitted use default black
    if (typeof styles["fill"] === "undefined") {
        styles["fill"] = "#000000";
    }

    generatedOutput += INDENT.repeat(groupLevel + 1) + '<path\n';
    if (toBool(localStorage.useIdAsName)) generatedOutput += generateAttr('name', styles["id"], groupLevel, "");
    generatedOutput += generateAttr('fillColor', parseColorToHex(styles["fill"]), groupLevel, "none");
    generatedOutput += generateAttr('fillAlpha', styles["fill-opacity"], groupLevel, "1");
    generatedOutput += generateAttr('strokeColor', parseColorToHex(styles["stroke"]), groupLevel, "none");
    generatedOutput += generateAttr('strokeAlpha', styles["stroke-opacity"], groupLevel, "1");
    generatedOutput += generateAttr('strokeWidth', removeNonNumeric(styles["stroke-width"]), groupLevel, "0");
    generatedOutput += generateAttr('strokeLineJoin', styles["stroke-linejoin"], groupLevel, "miter");
    generatedOutput += generateAttr('strokeMiterLimit', styles["stroke-miterlimit"], groupLevel, "4");
    generatedOutput += generateAttr('strokeLineCap', styles["stroke-linecap"], groupLevel, "butt");
    generatedOutput += generateAttr('pathData', pathData, groupLevel, null, true);
    pathsParsedCount++;
}

function generateCode(inputXml) {
    var resultData = { error:null, warnings:null, code:null };

    var xml;
    try {
        xml = $($.parseXML(inputXml));
    } catch (e) {
        resultData.error = "<b>Error:</b> not valid SVG file.";
        return resultData;
    }

    //Reset previous
    pathsParsedCount = 0;
    warnings = [];
    svgStyles = {};

    var svg = xml.find("svg");

    preprocessReferences(svg);

    if (toBool(localStorage.bakeTransforms)) {
        try {
            flatten(svg[0], false, true);
        } catch (e) {
            console.error(e);
            resultData.error = "<b>Error:</b> problem during parsing svg (flatten failed).";
            return resultData;
        }
    }

    var cssStyle = svg.find("style");
    if (cssStyle.length) {
        svgStyles = CSSJSON.toJSON(cssStyle.text().trim());
    }

    //Parse dimensions
    var dimensions = getDimensions(svg);
    var width = dimensions.width;
    var height = dimensions.height;

    var addVectorCompat = toBool(localStorage.addVectorCompat);

    //XML Vector start
    generatedOutput = '<?xml version="1.0" encoding="utf-8"?>\n';
    generatedOutput += '<vector xmlns:android="http://schemas.android.com/apk/res/android"';
    if (addVectorCompat) {
        generatedOutput += '\n' + INDENT + 'xmlns:app="http://schemas.android.com/apk/res-auto"';
        //These two lines aren't required, but they disable warnings by the Android linter
        generatedOutput += '\n' + INDENT + 'xmlns:tools="http://schemas.android.com/tools"';
        generatedOutput += '\n' + INDENT + 'tools:targetApi="21"';
    }
    generatedOutput += '\n' + INDENT + 'android:width="{0}dp"\n'.f(width);
    generatedOutput += INDENT + 'android:height="{0}dp"\n'.f(height);

    generatedOutput += INDENT + 'android:viewportWidth="{0}"\n'.f(width);
    if (addVectorCompat) {
        generatedOutput += INDENT + 'app:vc_viewportWidth="{0}"\n'.f(width);
    }

    generatedOutput += INDENT + 'android:viewportHeight="{0}"'.f(height);
    if (addVectorCompat) {
        generatedOutput += '\n' + INDENT + 'app:vc_viewportHeight="{0}"'.f(height);
    }

    generatedOutput += '>\n\n';

    //XML Vector content
    //Iterate through groups and paths
    recursiveTreeWalk(svg, 0);

    //XML Vector end
    generatedOutput += '</vector>';

    //SVG must contain path(s)
    if (pathsParsedCount == 0) {
        resultData.error = "No shape elements found in svg.";
        return resultData;
    }

    if (warnings.length == 1) {
        resultData.warnings = "<b>Warning:</b> " + warnings[0];
    } else if (warnings.length > 1) {
        var warnText = "";
        warnings.forEach(function (w, i) {
            warnText += "<tr><td><b>Warning #" + (i + 1) + ":</b></td><td>" + w + "</td></tr>";
        });
        resultData.warnings = "<table class='info-items'>" + warnText + "</table>";
    }

    resultData.code = generatedOutput;

    return resultData;
}

function parseSingleFile(inputXml) {
    lastFileData = inputXml;

    $(".alert").hide();

    var data = generateCode(inputXml);

    if (data.error !== null) {
        setMessage(data.error, "alert-danger");
        $("#output-box").hide();
    } else {
        if (data.warnings !== null) {
            setMessage(data.warnings, "alert-warning");
        }

        $("#output-code").text(data.code).animate({scrollTop: 0}, "fast");
        $("#output-box").fadeIn();
        $(".nouploadinfo").hide();
        $("#dropzone").animate({height: 50}, 500);
        $("#success-box").show();
    }
}

function parseMultipleFiles(inputXml) {
    var data = generateCode(inputXml);

    groupData.log += "<br><h4>" + lastFileName + "</h4>";
    if (data.warnings !== null) {
        groupData.log += data.warnings + "<br>";
    }

    if (data.error !== null) {
        groupData.log += data.error + "<br>";
        groupData.errors++;
    } else {
        if (data.warnings === null) {
            groupData.log += "OK<br>";
        }
        groupData.zip.file(extractFileNameWithoutExt(lastFileName) + ".xml", data.code);
    }
}

function fixPathPositioning(path) {
    return path.replace(/^\s*m/, START_PATH).replace(/^\s*z/, END_PATH);
}

function fixNumberFormatting(path) {
    return path.replace(/(\.\d+)(\.\d+)\s?/g, "\$1 \$2 ");
}

function getDimensions(svg) {
    var widthAttr = svg.attr("width");
    var heightAttr = svg.attr("height");
    var viewBoxAttr = svg.attr("viewBox");

    if (typeof viewBoxAttr === "undefined") {
        if (typeof widthAttr === "undefined" || typeof heightAttr === "undefined") {
            pushUnique(warnings, "width or height not set for svg (set -1)");
            return {width: -1, height: -1};
        } else {
            return {width: convertDimensionToPx(widthAttr), height: convertDimensionToPx(heightAttr)};
        }
    } else {
        var viewBoxAttrParts = viewBoxAttr.split(/[,\s]+/);
        if (viewBoxAttrParts[0] > 0 || viewBoxAttrParts[1] > 0) {
            pushUnique(warnings, "viewbox minx/miny is other than 0 (not supported)");
        }
        return {width: viewBoxAttrParts[2], height: viewBoxAttrParts[3]};
    }

}

function removeNonNumeric(input) {
    if (typeof input === "undefined") return input;
    return input.replace(/[^0-9.]/g, "");
}


function generateAttr(name, val, groupLevel, def, end) {
    if (typeof val === "undefined" || val == def) return "";
    var addVectorCompat = toBool(localStorage.addVectorCompat);

    var result = INDENT.repeat(groupLevel + 2) + 'android:{0}="{1}"'.f(name, val);

    if (addVectorCompat) {
        result += '\n' + INDENT.repeat(groupLevel + 2) + 'app:vc_{0}="{1}"'.f(name, val);
    }
    if (end) {
        result += ' />';
    }
    result += '\n';
    return result;
}

function selectAll() {
    var el = $("#output-code")[0];
    if (typeof window.getSelection != "undefined" && typeof document.createRange != "undefined") {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    } else if (typeof document.selection != "undefined" && typeof document.body.createTextRange != "undefined") {
        var textRange = document.body.createTextRange();
        textRange.moveToElementText(el);
        textRange.select();
    }
}

function download() {
    var blob = new Blob([$("#output-code").text()], {type: "text/xml;charset=utf-8"});
    var filename = extractFileNameWithoutExt(lastFileName) || "";
    saveAs(blob, filename.length > 0 ? (filename + ".xml") : "vector.xml");
}

function dropzoneClick() {
    $("#dropzone-dialog").click();
}

function setMessage(text, type) {
    var info = $("." + type + ".box");
    info.html(text);
    info.removeClass();
    info.addClass("alert");
    info.addClass("box");
    info.addClass(type);
    info.show();
}

function useIdAsName(el) {
    localStorage.useIdAsName = el.checked;
    if (groupData.groupSize == 1) parseSingleFile(lastFileData);
}

function bakeTransforms(el) {
    localStorage.bakeTransforms = el.checked;
    if (groupData.groupSize == 1) parseSingleFile(lastFileData);
}

function clearGroups(el) {
    localStorage.clearGroups = el.checked;
    if (groupData.groupSize == 1) parseSingleFile(lastFileData);
}

function addVectorCompatSupport(el) {
    localStorage.addVectorCompat = el.checked;
    if (groupData.groupSize == 1) parseSingleFile(lastFileData);
}

function wordwrap(str, width, brk, cut) {
    brk = brk || '\n';
    width = width || 75;
    cut = cut || false;

    if (!str) {
        return str;
    }

    var regex = '.{1,' + width + '}(\\s|$)' + (cut ? '|.{' + width + '}|.+$' : '|\\S+?(\\s|$)');

    var matches = str.match(new RegExp(regex, 'g'));
    // trim off leading/trailing spaces from the matched strings
    for (i = 0; i < matches.length; i++) {
        matches[i] = matches[i].trim();
    }

    return matches.join(brk);
}

//Parse rgb, named colors to hex
function parseColorToHex(color) {
    if (typeof color === "undefined") return color;
    color = color.replace(/\s/g, "");

    //Is hex already
    if (color.substr(0, 1) === "#") {
        return color;
    } else {
        if (color.startsWith("rgb(")) {
            var match = /rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(color);
            return match !== null && match.length >= 4 ? $c.rgb2hex(parseInt(match[1]), parseInt(match[2]), parseInt(match[3])) : color;
        } else {
            var hexClr = $c.name2hex(color);
            return !hexClr.startsWith("Invalid") ? hexClr : color;
        }
    }
}

function convertDimensionToPx(dimen) {
    var val = removeNonNumeric(dimen);
    var METER_TO_PX = 3543.30709;
    var INCH_TO_PX = 90;
    var PT_TO_PX = 1.25;
    var PC_TO_PX = 15;
    var FT_TO_PX = 1080;

    if (dimen.endsWith("mm")) {
        return val * (METER_TO_PX / 1000);
    } else if (dimen.endsWith("cm")) {
        return val * (METER_TO_PX / 100);
    } else if (dimen.endsWith("m")) {
        return val * METER_TO_PX;
    } else if (dimen.endsWith("in")) {
        return val * INCH_TO_PX;
    } else if (dimen.endsWith("pt")) {
        return val * PT_TO_PX;
    } else if (dimen.endsWith("pc")) {
        return val * PC_TO_PX;
    } else if (dimen.endsWith("ft")) {
        return val * FT_TO_PX;
    } else {
        return val;
    }
}