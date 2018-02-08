const aStar = require('./a-star');

const SEARCH_TIMEOUT = 50;
const COST_HEAVY = 1000;
const COST_MODERATE = 250;
const COST_LIGHT = 100;

let state = {};

// Handle start requests
module.exports.start = function(req, res) {
  state = req.body;

  // Response data
  var data = {
    color: "#b2d8ff",
    name: "Come Slither",
    head_url: "http://www.placecage.com/c/200/200", // optional, but encouraged!
    taunt: "START",
  };

  return res.json(data);
}

// Handle move requests
module.exports.move = function(req, res) {
  console.log('-');
  state = req.body;

  let ourSnake = getSnake(state);
  let ourHead  = getHeadNode(ourSnake);
  let ourTail  = getTailNode(ourSnake);

  let result;
  let results = [];

  // compute paths to food
  for (let i = 0; i < state.food.data.length; i++) {
    result = aStarSearch(state, ourHead, [state.food.data[i]]);
    if (result.status != 'success') continue;
    result.goal = 'FOOD';
    results.push(result);
  }

  // eliminate food paths that we can't fit into
  results = results.filter((result) => {
    if (result.path.length < 2) return false;
    let spaceSize = getSpaceSize(state, result.path[1]);
    return spaceSize > ourSnake.body.data.length;
  });

  // determine closest food
  let closestFood = results.reduce((closest, current) => {
    return Math.min(current.path.length, closest);
  }, Number.MAX_SAFE_INTEGER);

  // we want to the be closest snake to at least one piece of food
  // determine how close we are vs. how close our enemies are
  let foodDistances = [];
  for (let i = 0; i < results.length; i++) {
    result = results[i];
    let foodNode = result.path[result.path.length - 1];
    let ourDistance = distance(ourHead, foodNode);
    let otherDistance = enemyDistance(state, foodNode);
    foodDistances.push({
      foodNode,
      ourDistance,
      enemyDistance: otherDistance,
      advantage: otherDistance - ourDistance
    })
  }
  let foodAdvantages = foodDistances.slice().sort((a, b) => b.advantage - a.advantage);
  let foodOpportunities = foodDistances.slice().sort((a, b) => b.enemyDistance - a.enemyDistance);
  let foodAdvantage = foodAdvantages.length && foodAdvantages[0];
  let foodOpportunity = foodOpportunities.length && foodOpportunities[0];

  // 'must eat' if steps to food consume >70% of health
  // 'should eat' if steps to food consume >30% of health
  // 'seek food' if food advantage is < 3
  let canEat = results.length;
  let mustEat = canEat && (ourSnake.health * .7) < closestFood;
  let shouldEat = canEat && (ourSnake.health * .3) < closestFood;
  let seekFood = foodAdvantage && foodAdvantage.advantage < 3;
  console.log('SHOULD/MUST/SEEK', shouldEat, mustEat, seekFood);

  // if eating is optional, seek tail nodes
  if (!mustEat) {
    let tailTargets = goodNeighbors(state, ourTail);
    if (!isGrowing(ourSnake)) tailTargets.push(ourTail);
    for (let i = 0; i < tailTargets.length; i++) {
      result = aStarSearch(state, ourHead, [tailTargets[i]]);
      if (result.status != 'success') continue;
      result.goal = 'TAIL';
      results.push(result);
    }
  }

  // adjust the cost of paths
  for (let i = 0; i < results.length; i++) {
    let result = results[i];
    let path = result.path;
    let endNode = path[path.length - 1];
    let startNode = path[1];

    // heavily if end point has no path back to our tail
    if (!hasPathToTail(state, endNode, ourSnake)) {
      result.cost += COST_HEAVY;
    }

    // heavily if not a food path and start point has no path to food (in time)
    if (result.goal !== 'FOOD' && !hasPathToFood(state, startNode, ourSnake)) {
      result.cost += COST_HEAVY;
    }

    // moderately if not a food path and we should be eating
    if (result.goal !== 'FOOD' && (shouldEat || mustEat || seekFood)) {
      result.cost += COST_MODERATE;
    }

    // lightly if a food path and we should not be eating
    if (result.goal === 'FOOD' && (!shouldEat && !mustEat && !seekFood)) {
      result.cost += COST_LIGHT;
    }

    // lightly if: food path, multiple food paths, no advantage, not most available
    if (result.goal === 'FOOD'
      && state.food.data.length > 1
      && foodAdvantage
      && foodAdvantage.advantage < 1
      && getNodeHash(endNode) !== getNodeHash(foodOpportunity.foodNode)
    ) {
      result.cost += COST_LIGHT;
    }
  }

  // if we found paths to goals, pick cheapest one
  if (results.length) {
    results.sort((a, b) => {
      return a.cost - b.cost;
    });
    results.forEach(result => console.log(result.goal, result.cost));
    return moveResponse(
      res,
      direction(ourHead, results[0].path[1]),
      'A* BEST PATH TO ' + results[0].goal
    );
  }

  // no best moves, pick the direction that has the most open space
  let moves = [];
  let headNeighbors = validNeighbors(state, ourHead);
  for (let i = 0; i < headNeighbors.length; i++) {
    let neighbor = headNeighbors[i];
    moves.push({
      node: neighbor,
      direction: direction(ourHead, neighbor),
      spaceSize: getSpaceSize(state, neighbor),
      wallCost: getWallCost(state, neighbor),
      isNextMove: isPossibleNextMove(state, getOtherSnakes(state), neighbor)
    });
  }
  moves.sort((a, b) => {
    // avoid nodes enemy snakes might move into
    if (a.spaceSize == b.spaceSize && a.isNextMove != b.isNextMove) {
      return a.isNextMove - b.isNextMove;
    }

    // don't cut off escape routes
    if (a.spaceSize == b.spaceSize) {
      return a.wallCost - b.wallCost;
    }

    return b.spaceSize - a.spaceSize;
  });
  if (moves.length) {
    return moveResponse(
      res,
      direction(ourHead, moves[0].node),
      'NO PATH TO GOAL, LARGEST SPACE'
    );
  }

  // no valid moves
  return moveResponse(res, 'up', 'FML');
}

function moveResponse(res, move, taunt) {
  taunt = taunt + ' ' + move;
  console.log(taunt);
  return res.json({move, taunt});
}

function enemyDistance(state, node) {
  let enemySnakes = getOtherSnakes(state);
  return enemySnakes.reduce((closest, current) => {
    let headNode = getHeadNode(current);
    return Math.min(distance(node, headNode), closest);
  }, Number.MAX_SAFE_INTEGER);
}

// *** add a pessimistic mode that 'adds 3 heads' to each snake
function getSpaceSize(state, node) {
  let validNodes = [node];
  let seenNodes  = {};
  seenNodes[getNodeHash(node)] = true;

  for (let i = 0; i < validNodes.length; i++) {
    let neighbors = validNeighbors(state, validNodes[i]);
    for (let j = 0; j < neighbors.length; j++) {
      if (!seenNodes[getNodeHash(neighbors[j])]) {
        seenNodes[getNodeHash(neighbors[j])] = true;
        validNodes.push(neighbors[j]);
      }
    }
  }

  return validNodes.length;
}

function hasPathToTail(state, startNode, snake) {
  let snakeTail = getTailNode(snake);
  let result = aStarSearch(state, startNode, validNeighbors(state, snakeTail));
  return result.status == 'success';
}

function hasPathToFood(state, startNode, snake) {
  let snakeHead = getTailNode(snake);
  let result = aStarSearch(state, snakeHead, state.food.data);
  return result.status == 'success' && result.path.length < state.you.health;
}

function getHeadNode(snake) {
  return snake.body.data.slice(0,1)[0];
}

function getTailNode(snake) {
  return snake.body.data.slice(-1)[0];
}

function getSnake(state, snakeId) {
  if (!snakeId) snakeId = state.you.id;
  for (let snake of state.snakes.data) {
    if (snake.id == snakeId) return snake;
  }
}

function getOtherSnakes(state, snakeId) {
  if (!snakeId) snakeId = state.you.id;
  return state.snakes.data.filter((snake) => {
    return snake.id != snakeId;
  });
}

function getHurtfulSnakes(state, snakeId) {
  if (!snakeId) snakeId = state.you.id;
  let subjectSnake = getSnake(state, snakeId);
  return state.snakes.data.filter((snake) => {
    return snake.id != snakeId && snake.body.data.length >= subjectSnake.body.data.length;
  });
}

function isSameNode(a, b) {
  return a.x === b.x && a.y === b.y;
}

function isInNodes(node, nodes) {
  for (let i = 0; i < nodes.length; i++) {
    if (node.x === nodes[i].x && node.y === nodes[i].y) return true;
  }
  return false;
}

function isAdjacent(a, b) {
    if (a.x == b.x) {
      return a.y == b.y-1 || a.y == b.y+1
    } else if (a.y == b.y) {
      return a.x == b.x-1 || a.x == b.x+1
    }
    return false;
}

function isSnake(state, node) {
  for (let i = 0; i < state.snakes.data.length; i++) {
    if (isInNodes(node, state.snakes.data[i].body.data)) {
      return true;
    }
  }
  return false;
}

function isFood(state, node) {
  return isInNodes(node, state.food.data);
}

function isWall(state, node) {
  return node.x < 0 || node.x >= state.width || node.y < 0 || node.y >= state.height;
}

function distance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function neighbors(node) {
  return [
    {x: node.x - 1, y: node.y},
    {x: node.x + 1, y: node.y},
    {x: node.x, y: node.y - 1},
    {x: node.x, y: node.y + 1}
  ];
}

function validNeighbors(state, node) {
  return neighbors(node).filter((node) => {
    // walls are not valid
    if (isWall(state, node)) return false;

    // don't consider occupied nodes unless they are moving tails
    if (isSnake(state, node) && !isMovingTail(state, node)) return false;

    // looks valid
    return true;
  });
}

function goodNeighbors(state, node) {
  return validNeighbors(state, node).filter((node) => {
    // don't consider nodes adjacent to the head of a bigger snake
    return !isPossibleNextMove(state, getHurtfulSnakes(state), node);
  });
}

function isMovingTail(state, node) {
  for (let i = 0; i < state.snakes.data.length; i++) {
    let body = state.snakes.data[i].body.data;

    // if it's not the tail node, consider next snake
    if (!isSameNode(node, body[body.length - 1])) continue;

    // if snake is growing, tail won't move
    if (isGrowing(state.snakes.data[i])) return false;

    // must be a moving tail
    return true;
  }
  return false;
}

function isGrowing(snake) {
  let body = snake.body.data;
  return isSameNode(body[body.length - 1], body[body.length - 2]);
}

function isPossibleNextMove(state, snakes, node) {
  return snakes.some((snake) => {
    return isInNodes(node, neighbors(getHeadNode(snake)));
  });
}

function getProximityToSnakes(state, snakes, node) {
  let proximity = 0;
  let halfBoard = (Math.min(state.width, state.height) - 1) / 2;
  for (let i = 0; i < snakes.length; i++) {
    if (snakes[i].id === state.you.id) continue;

    let headNode = getHeadNode(snakes[i]);
    let gap = distance(headNode, node);

    // insignificant proximity if > half the board away
    if (gap >= halfBoard) continue;

    // otherwise, proximity is closeness squared, then quartered
    proximity += Math.pow(halfBoard - gap, 2) / 4
  }

  return proximity;
}

function heuristic(state, node) {
  // cost goes up if node is close to a wall because that limits escape routes
  let cost = getWallCost(state, node);

  // cost goes up if node is close to another harmful snake
  cost += getProximityToSnakes(state, getHurtfulSnakes(state), node);

  return cost;
}

function direction(fromNode, toNode) {
  if (fromNode.y > toNode.y) return 'up';
  if (fromNode.y < toNode.y) return 'down';
  if (fromNode.x > toNode.x) return 'left';
  if (fromNode.x < toNode.x) return 'right';
}

function aStarSearch(state, startNode, targets) {
  let options = {
    start: startNode,
    isEnd: (node) => isInNodes(node, targets),
    neighbor: (node) => goodNeighbors(state, node),
    distance: distance,
    heuristic: (node) => heuristic(state, node),
    hash: getNodeHash,
    timeout: SEARCH_TIMEOUT
  }
  return aStar(options);
}

function getNodeHash(node) {
  return `${node.x},${node.y}`
}

function getWallCost(state, node) {
  let halfWidth  = (state.width - 1) / 2;
  let halfHeight = (state.height - 1) / 2;
  let deviation  = [
    Math.abs(node.x - halfWidth)  / halfWidth,
    Math.abs(node.y - halfHeight) / halfHeight
  ];

  return Math.round(Math.max(...deviation) * ((halfWidth + halfHeight) / 4));
}

function getOccupiedNodes(snakes) {
  let nodes = [];
  for (let snake of snakes) {
    for (let i = 0; i < snake.body.data.length; i++) {
      nodes.push(snake.body.data[i]);
    }
  }
  return nodes;
}