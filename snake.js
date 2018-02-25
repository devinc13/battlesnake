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
    color: "#000000",
    name: "I stole Slither",
    head_url: "https://cdn1.iconfinder.com/data/icons/ahasoft-military-2/512/crime_mask-512.png",
    taunt: "Sneak sneak",
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
    // Don't consider food that we can't reach without dying
    if (result.status != 'success' || (result.path.length - 1) > ourSnake.health) continue;
    result.goal = 'FOOD';
    results.push(result);
  }

  let dangerousResults = results;

  // eliminate food paths that we can't fit into
  // compute space size pessimistically (avoid nodes next to enemy heads)
  results = results.filter((result) => {
    if (result.path.length < 2) return false;
    let spaceSize = getSpaceSize(state, result.path[1], true);
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

  // 'must eat' if steps to food consume >50% of health
  // 'should eat' if health < 20% or steps to food consume >25% of health
  // 'seek food' if food advantage is < 5
  let canEat = results.length > 0;

  // If we are super low on health, check for any dangerous food we can consider -
  // the space size check isn't pessimistic
  if (!canEat && ourSnake.health < 4) {
    results = dangerousResults.filter((result) => {
      if (result.path.length < 2) return false;
      let spaceSize = getSpaceSize(state, result.path[1]);
      return spaceSize > ourSnake.body.data.length;
    });

    canEat = results.length > 0;
  }

  let mustEat = canEat && closestFood > (ourSnake.health * .5);
  let shouldEat = canEat && (ourSnake.health < 25 || closestFood > (ourSnake.health * .25));
  let seekFood = canEat && foodAdvantage && foodAdvantage.advantage < 5;
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
      result.cost += shouldEat || mustEat ? COST_MODERATE : COST_LIGHT;
    }

    // lightly if a food path and we should not be eating
    if (result.goal === 'FOOD' && (!shouldEat && !mustEat && !seekFood)) {
      result.cost += COST_LIGHT;
    }

    // lightly if: food path, multiple food paths, not our advantage and not most available
    if (result.goal === 'FOOD'
      && state.food.data.length > 1
      && (getNodeHash(endNode) !== getNodeHash(foodAdvantage.foodNode) || foodAdvantage.advantage < 1)
      && getNodeHash(endNode) !== getNodeHash(foodOpportunity.foodNode)
    ) {
      result.cost += COST_LIGHT;
    }
  }

  results = filterDangerousResults(state, results, ourSnake);
  // if we found paths to goals, pick cheapest one
  if (results.length) {
    results.sort((a, b) => {
      return a.cost - b.cost;
    });

    results.forEach(result => console.log(result.goal, result.cost));
    console.log("Goal = " + results[0].goal);
    return moveResponse(res, direction(ourHead, results[0].path[1]), state.turn);
  }

  // no best moves, pick the direction that has the most open space
  // first be pessimistic and avoid nodes next to enemy heads
  // if that fails, be optimistic and include nodes next to enemy heads
  let moves = getSpaciousMoves(state, ourHead, true);
  moves = moves.filter((result) => {
    return result.spaceSize > ourSnake.body.data.length;
  });

  moves = moves.length ? moves : getSpaciousMoves(state, ourHead);
  moves.sort((a, b) => {
    // avoid nodes bigger enemy snakes might move into
    if (a.spaceSize === b.spaceSize && a.isNextMove !== b.isNextMove) {
      return a.isNextMove - b.isNextMove;
    }

    // don't cut off escape routes
    if (a.spaceSize === b.spaceSize) {
      return a.wallCost - b.wallCost;
    }

    return b.spaceSize - a.spaceSize;
  });

  console.log("Making a safe move");
  if (moves.length) {
    return moveResponse(res, direction(ourHead, moves[0].node), state.turn);
  }

  console.log("No valid moves");
  // no valid moves
  return moveResponse(res, 'up', state.turn);
}

function filterDangerousResults(state, results, ourSnake) {
  if (!results.length) {
    return [];
  }

  pessimisticSafeResults = results.filter((result) => {
    // Check size of area from the first move of this path - start with pessimistic - don't filter tail
    return (getSpaceSize(state, results[0].path[1], true) > ourSnake.body.data.length) || (result.goal == 'TAIL');
  });

  if (pessimisticSafeResults.length) {
    return pessimisticSafeResults;
  }

  // If we didn't find any pessimistic safe results, get optimistic safe results - don't filter tail
  optimisticSafeResults = results.filter((result) => {
    return (getSpaceSize(state, results[0].path[1]) > ourSnake.body.data.length) || (result.goal == 'TAIL');
  });

  return optimisticSafeResults;
}

function getSpaciousMoves(state, ourHead, pessimistic) {
  let moves = [];
  let headNeighbors = pessimistic
    ? goodNeighbors(state, ourHead, true)
    : validNeighbors(state, ourHead);

  for (let i = 0; i < headNeighbors.length; i++) {
    let neighbor = headNeighbors[i];
    moves.push({
      node: neighbor,
      direction: direction(ourHead, neighbor),
      spaceSize: getSpaceSize(state, neighbor, pessimistic),
      wallCost: getWallCost(state, neighbor),
      isNextMove: isPossibleNextMove(state, getBiggerSnakes(state), neighbor)
    });
  }
  return moves;
}

function moveResponse(res, move, turn) {
  console.log("Move = " + move);
  taunt = turn % 8 ? "......" : "Sneaky";
  return res.json({move, taunt});
}

function enemyDistance(state, node) {
  let enemySnakes = getOtherSnakes(state);
  return enemySnakes.reduce((closest, current) => {
    let headNode = getHeadNode(current);
    return Math.min(distance(node, headNode), closest);
  }, Number.MAX_SAFE_INTEGER);
}

function getSpaceSize(state, node, pessimistic) {
  map = makeFloodMap(state, pessimistic);
  filled = [];
  floodFill(map, node.x, node.y, filled);
  return filled.length;
}

function floodFill(map, x, y, filled) {
  if (map[y][x] == 0) {
    // Mark as visited
    map[y][x] = 1;
    filled.push({'x': x, 'y': y});

    // Check surrounding spots:
    if (x > 0) {
      floodFill(map, x - 1, y, filled)
    }

    if (x < map[y].length - 1){
      floodFill(map, x + 1, y, filled)
    }

    if (y > 0) {
      floodFill(map, x, y - 1, filled)
    }

    if (y < map.length - 1) {
      floodFill(map, x, y + 1, filled)
    }
  }
}

function makeFloodMap(state,  pessimistic) {
  let map = [];

  for (let x = 0; x < state.height; x++) {
    row = [];
    for (let y = 0; y < state.width; y++) {
        row.push(0);
    }

    map.push(row);
  }

  for (let snake of state.snakes.data) {
    // Cut off end of tail, since this will move on the next turn
    for (let y = 0; y < snake.body.data.length - 1; y++) {
      let coord = snake.body.data[y];
      map[coord.y][coord.x] = 1;

      // Fill in other spaces besides the snake heads if being pessimistic
      if (pessimistic && y == 0 && snake.id != state.you.id) {
        let neighbors = validNeighbors(state, {'x': coord.x, 'y': coord.y});
        for (let j = 0; j < neighbors.length; j++) {
          map[neighbors[j].y][neighbors[j].x] = 1;
        }
      }
    }
  }

  return map;
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

function getBiggerSnakes(state, snakeId) {
  if (!snakeId) snakeId = state.you.id;
  let subjectSnake = getSnake(state, snakeId);
  return state.snakes.data.filter((snake) => {
    return snake.id != snakeId && snake.body.data.length >= subjectSnake.body.data.length;
  });
}

function isSameNode(a, b) {
  return a.x === b.x && a.y === b.y;
}

function isInNodes(node, nodes, tailTrim) {
  tailTrim = tailTrim || 0;
  for (let i = 0; i < (nodes.length - tailTrim); i++) {
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

function isSnake(state, node, tailTrim) {
  for (let i = 0; i < state.snakes.data.length; i++) {
    if (isInNodes(node, state.snakes.data[i].body.data, tailTrim)) {
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

function validNeighbors(state, node, tailTrim) {
  return neighbors(node).filter((node) => {
    // walls are not valid
    if (isWall(state, node)) return false;

    // don't consider occupied nodes unless they are moving tails
    if (isSnake(state, node, tailTrim) && !isMovingTail(state, node)) return false;

    // looks valid
    return true;
  });
}

function goodNeighbors(state, node, headShot, tailTrim) {
  let otherSnakes = headShot ? getBiggerSnakes(state) : getOtherSnakes(state);
  return validNeighbors(state, node, tailTrim).filter((node) => {
    // don't consider nodes adjacent to the head of another snake
    return !isPossibleNextMove(state, otherSnakes, node);
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
  let quarterBoard = (Math.min(state.width, state.height) - 1) / 4;
  for (let i = 0; i < snakes.length; i++) {
    if (snakes[i].id === state.you.id) continue;

    let headNode = getHeadNode(snakes[i]);
    let gap = distance(headNode, node);

    // insignificant proximity if > 1/4 of the board away
    if (gap >= quarterBoard) continue;

    proximity += (quarterBoard - gap) * 10
  }

  return proximity;
}

function heuristic(state, node) {
  // cost goes up if node is close to a wall because that limits escape routes
  let cost = getWallCost(state, node);

  // cost goes up if node is close to another snake
  cost += getProximityToSnakes(state, getOtherSnakes(state), node);

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
    neighbor: (node, path) => {
      return goodNeighbors(state, node, node === startNode, path.length)
    },
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