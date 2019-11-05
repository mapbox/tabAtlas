const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const vorpal = require("vorpal")();
const fetch = require("node-fetch");
const https = require("https");
const process = require("process");
const homedir = require("os").homedir();
const agent = new https.Agent({
  rejectUnauthorized: false
});

const templatePath = path.join(__dirname, "Template.tms");
const template = fs.readFileSync(templatePath);
const tms = template.toString();

const generateList = (objectList, keyword) => {
  const keys = Object.keys(objectList);
  const listFilter = keys.filter(item => item.includes(keyword));
  const list = listFilter.map(item => {
    return objectList[item];
  });
  return list;
};

const urlPromises = array => {
  const promises = array.map(style => {
    return fetch(style, { agent });
  });
  return promises;
};

const testStatus = arrayOfResults => {
  arrayOfResults.forEach((result, index) => {
    if (result.status !== 200) {
      throw new Error(`URL ${index} is incorrect`);
    }
  });
};

const preTest = answers => {
  let styleUrls = generateList(answers, "style");
  let names = generateList(answers, "name");
  Promise.all(urlPromises(styleUrls)).then(results => {
    testStatus(results);
  });
  return { urls: styleUrls, names: names };
};

const generateTMS = (styles, styleName, repository) => {
  //*Parse and update the XML
  const parser = new xml2js.Parser();
  parser.parseStringPromise(tms).then(result => {
    /**
     * Tableau TMS has five essential nodes, all under the mapsource node
     * @property {connection} mapsouce.connection[0] - Information required to build the API calls to Mapbox
     * @property {layers} mapsource.layers[0] - List of layers to be shown in the UI
     * @property {map-styles} mapsource['map-styles'][0] - List of styles, with information passed to the API constructor
     * @property {map-defaults} mapsource['mapsource-defaults'][0] - List of defaults for the selected map style
     */
    let mapsource = result.mapsource;
    let connection = mapsource.connection[0];
    let layers = mapsource.layers[0];
    let mapStyles = mapsource["map-styles"][0];
    let mapDefaults = mapsource["mapsource-defaults"][0];
    //* Step 1: Handle Inputs
    /**
     * Similar to how Tableau currently parses Mapbox URLs, this will return an object that contains all the components necessary for build the rest of the XML
     * @property {scheme} - HTTP or HTTPS
     * @property {port} - Optional. HTTP can be 80 or arbitrary number. HTTPS is 443.
     * @property {server} - Path to server. Example: api.mapbox.com
     * @property {url} - Path to endpoint. Example: /styles/v1
     * @property {username} - Username. Default for Atlas is atlas-user
     * @property {style} - Selected Mapbox style
     * @property {token} - Atlas token. Must begin with pk.
     */
    const styleSplit = styles.map(style => {
      const internalSplit = style.split("/");
      const paramSplit = internalSplit[6].split(".");
      const tokenSplit = internalSplit[6].split("=");
      let styleInfo = {};
      styleInfo.scheme = internalSplit[0];
      styleInfo.server = internalSplit[2].split(":")[0];
      if (internalSplit[0] === "https:") {
        styleInfo.port = "443";
      } else {
        styleInfo.port =
          internalSplit[2].split(":")[1] === undefined
            ? "80"
            : internalSplit[2].split(":")[1];
      }
      styleInfo.url = `${internalSplit[3]}/${internalSplit[4]}`;
      styleInfo.username = internalSplit[5];
      styleInfo.style = paramSplit[0];
      styleInfo.token = tokenSplit[2].split("#")[0];
      return styleInfo;
    });
    //* Step 2: Edit Connection
    /**
     * Connection requires the following
     * @property {api-key} - Mapbox token
     * @property {port} - HTTP port
     * @property {server} - Full HTTP connection string
     * @property {url} - URL path to stylesclear
     * @property {username} - Mapbox Atlas username (typically atlas-user)
     * @property {url-format} - Concatenated string to describe how to fetch data. Has format of `#{url}/${username}/{L}/tiles/{Z}/{X}/{Y}/{D}?access_token={api-key}`
     */
    let connectionAttributes = connection["$"];
    connectionAttributes["api-key"] = styleSplit[0].token;
    connectionAttributes.server = `${styleSplit[0].scheme}//${styleSplit[0].server}`;
    connectionAttributes.url = styleSplit[0].url;
    connectionAttributes.port = styleSplit[0].port;
    connectionAttributes.username = styleSplit[0].username;
    connectionAttributes[
      "url-format"
    ] = `/${styleSplit[0].url}/${styleSplit[0].username}/{L}/tiles/{Z}/{X}/{Y}{D}?access_token=${styleSplit[0].token}`;
    //* Step 3: Edit Layers
    /**
     * Layers contain the following Attributes
     * @property {display-name} - Name of the style itself
     * @property {name} - Mapbox StyleID
     */
    delete layers.layer;
    const newLayers = styleSplit.map((style, index) => {
      const layerMetadata = {
        $: {
          "display-name": styleName[index],
          name: style.style,
          "show-ui": true,
          type: "features"
        }
      };
      return layerMetadata;
    });
    layers.layer = newLayers;
    //* Step 4: Edit Map Styles
    /**
     * Each Map Style contains the following
     * @property {map-style} - Name of Style and Full URL to request that style. This is the parent of map-layer-style
     * @property {map-layer-style} - Name of layer and Mapbox ID
     */
    delete mapStyles["map-style"];
    const newStyles = styleSplit.map((style, index) => {
      const styleMetadata = {
        $: {
          "display-name": styleName[index],
          name: `mapbox://styles/${style.username}/${style.style}`,
          "wait-tile-color": "#dddddd"
        },
        "map-layer-style": [
          {
            $: {
              name: styleName[index],
              "request-string": style.style
            }
          }
        ]
      };
      return styleMetadata;
    });
    mapStyles["map-style"] = newStyles;
    //* Step 5: Edit Map Defaults
    /**
     * Each Map Style needs some defaults, which lives underneath the style-rule node
     * @property {map-style} - Full Mapbox Style URL
     * @property {washout} - Map washout/opacity
     */
    delete mapDefaults.style[0]["style-rule"];
    const newDefaults = styleSplit.map((style, index) => {
      const defaultMetadata = {
        $: { element: "map" },
        format: [
          {
            $: {
              attr: "map-style",
              value: `mapbox://styles/${style.username}/${style.style}`
            }
          },
          {
            $: {
              attr: "washout",
              value: 0
            }
          }
        ]
      };
      return defaultMetadata;
    });
    mapDefaults.style[0]["style-rule"] = newDefaults;
    //* Step 6: Build the XML
    const builder = new xml2js.Builder();
    const newTMS = builder.buildObject(result);
    const outputPath = path.join(repository, "Mapsources", "Atlas.tms");
    fs.writeFileSync(outputPath, newTMS);
  });
};

const generatePrompt = number => {
  const style = {
    type: "input",
    name: `style${number}`,
    message: "What is your style URL? "
  };
  const name = {
    type: "input",
    name: `name${number}`,
    message: "What is your style name? "
  };
  return [style, name];
};

vorpal
  .command("generate", "Creates TMS")
  .option("-n,--number <styles>, Number of Sources")
  .action(function(args, cb) {
    const self = this;
    let prompts = [
      {
        type: "input",
        name: `repository`,
        message: "Where is the Tableau Repository on this machine? ",
        default: path.join(homedir, "Documents", "My Tableau Repository")
      }
    ];
    for (i = 0; i < args.options.number; i++) {
      const inititalTemplate = generatePrompt(i + 1);
      inititalTemplate.forEach(item => {
        prompts.push(item);
      });
    }
    const prompter = this.prompt(prompts);
    prompter.then(answers => {
      const TMSPrep = preTest(answers);
      generateTMS(TMSPrep.urls, TMSPrep.names, answers.repository);
      this.log("Atlas files written.");
      this.log(
        "Go to https://help.tableau.com/current/pro/desktop/en-gb/maps_mapsources.htm for help with setting this new TMS as Default"
      );
    });
    cb();
  });

vorpal.delimiter("atlasConfig$").show();
